const Web3 = require('web3');
const BigNumber = require('bignumber.js');
const cliProgress = require('cli-progress');
const fs = require('fs');
const { argv } = require('yargs');

const utils = require('./utils');
const poolAbi = require('./abi/BPool.json');
const tokenAbi = require('./abi/BToken.json');

const web3 = new Web3(
    new Web3.providers.WebsocketProvider(`ws://localhost:8546`)
);

BigNumber.config({
    EXPONENTIAL_AT: [-100, 100],
    ROUNDING_MODE: BigNumber.ROUND_DOWN,
    DECIMAL_PLACES: 18,
});

function bnum(val) {
    return new BigNumber(val.toString());
}

function getFeeFactor(feePercentage) {
    return Math.exp(-Math.pow(feePercentage / 2, 2));
}

function getRatioFactor(weights) {
    let ratioFactorSum = bnum(0);
    let pairWeightSum = bnum(0);
    let n = weights.length;
    for (j = 0; j < n; j++) {
        if (!weights[j].eq(bnum(0))) {
            for (k = j + 1; k < n; k++) {
                let pairWeight = weights[j].times(weights[k]);
                let normalizedWeight1 = weights[j].div(
                    weights[j].plus(weights[k])
                );
                let normalizedWeight2 = weights[k].div(
                    weights[j].plus(weights[k])
                );
                ratioFactorSum = ratioFactorSum.plus(
                    bnum(4)
                        .times(normalizedWeight1)
                        .times(normalizedWeight2)
                        .times(pairWeight)
                );
                pairWeightSum = pairWeightSum.plus(pairWeight);
            }
        }
    }

    ratioFactor = ratioFactorSum.div(pairWeightSum);

    return ratioFactor;
}

if (!argv.startBlock || !argv.endBlock || !argv.week) {
    console.log(
        'Usage: node index.js --week 1 --startBlock 10131642 --endBlock 10156690'
    );
    process.exit();
}

const END_BLOCK = argv.endBlock; // Closest block to reference time at end of week
const START_BLOCK = argv.startBlock; // Closest block to reference time at beginning of week
const WEEK = argv.week; // Week for mining distributions. Ex: 1

const BAL_PER_WEEK = bnum(145000);
const BLOCKS_PER_SNAPSHOT = 64;
const BAL_PER_SNAPSHOT = BAL_PER_WEEK.div(
    bnum(Math.ceil((END_BLOCK - START_BLOCK) / 64))
); // Ceiling because it includes end block

async function getRewardsAtBlock(i, pools, prices, poolProgress) {
    let totalBalancerLiquidity = bnum(0);

    let block = await web3.eth.getBlock(i);

    let userPools = {};
    let userLiquidity = {};

    poolProgress.update(0, { task: `Block ${i} Progress` });
    for (const pool of pools) {
        let poolAddress = pool.id;

        // Check if at least two tokens have a price
        let atLeastTwoTokensHavePrice = false;
        let nTokensHavePrice = 0;

        if (pool.createTime > block.timestamp || !pool.tokensList) {
            poolProgress.increment(1);
            continue;
        }

        for (const t of pool.tokensList) {
            let token = web3.utils.toChecksumAddress(t);
            if (prices[token] !== undefined && prices[token].length > 0) {
                nTokensHavePrice++;
                if (nTokensHavePrice > 1) {
                    atLeastTwoTokensHavePrice = true;
                    break;
                }
            }
        }

        if (!atLeastTwoTokensHavePrice) {
            poolProgress.increment(1);
            continue;
        }

        let bPool = new web3.eth.Contract(poolAbi, poolAddress);

        let publicSwap = await bPool.methods.isPublicSwap().call(undefined, i);
        if (!publicSwap) {
            poolProgress.increment(1);
            continue;
        }

        let shareHolders = pool.shares.flatMap((a) => a.userAddress.id);

        let poolMarketCap = bnum(0);
        let poolMarketCapFactor = bnum(0);

        let currentTokens = await bPool.methods
            .getCurrentTokens()
            .call(undefined, i);
        let poolRatios = [];

        for (const t of currentTokens) {
            // Skip token if it doesn't have a price
            let token = web3.utils.toChecksumAddress(t);
            if (prices[token] === undefined || prices[token].length === 0) {
                continue;
            }
            let bToken = new web3.eth.Contract(tokenAbi, token);
            let tokenBalanceWei = await bPool.methods
                .getBalance(token)
                .call(undefined, i);
            let tokenDecimals = await bToken.methods.decimals().call();
            let normWeight = await bPool.methods
                .getNormalizedWeight(token)
                .call(undefined, i);

            let closestPrice = prices[token].reduce((a, b) => {
                return Math.abs(b[0] - block.timestamp * 1000) <
                    Math.abs(a[0] - block.timestamp * 1000)
                    ? b
                    : a;
            })[1];

            let tokenBalance = utils.scale(tokenBalanceWei, -tokenDecimals);
            let tokenMarketCap = tokenBalance.times(bnum(closestPrice)).dp(18);
            poolRatios.push(utils.scale(normWeight, -18));
            poolMarketCap = poolMarketCap.plus(tokenMarketCap);
        }

        let ratioFactor = getRatioFactor(poolRatios);

        let poolFee = await bPool.methods.getSwapFee().call(undefined, i);
        poolFee = utils.scale(poolFee, -16); // -16 = -18 * 100 since it's in percentage terms
        let feeFactor = bnum(getFeeFactor(poolFee));

        poolMarketCapFactor = feeFactor
            .times(ratioFactor)
            .times(poolMarketCap)
            .dp(18);
        totalBalancerLiquidity = totalBalancerLiquidity.plus(
            poolMarketCapFactor
        );

        let bptSupplyWei = await bPool.methods.totalSupply().call(undefined, i);
        let bptSupply = utils.scale(bptSupplyWei, -18);

        if (bptSupply.eq(bnum(0))) {
            // Private pool
            if (userPools[pool.controller]) {
                userPools[pool.controller].push({
                    pool: poolAddress,
                    feeFactor: feeFactor.toString(),
                    ratioFactor: ratioFactor.toString(),
                    valueUSD: poolMarketCap.toString(),
                    factorUSD: poolMarketCapFactor.toString(),
                });
            } else {
                userPools[pool.controller] = [
                    {
                        pool: poolAddress,
                        feeFactor: feeFactor.toString(),
                        ratioFactor: ratioFactor.toString(),
                        valueUSD: poolMarketCap.toString(),
                        factorUSD: poolMarketCapFactor.toString(),
                    },
                ];
            }

            // Add this pool liquidity to total user liquidity
            if (userLiquidity[pool.controller]) {
                userLiquidity[pool.controller] = bnum(
                    userLiquidity[pool.controller]
                )
                    .plus(poolMarketCapFactor)
                    .toString();
            } else {
                userLiquidity[pool.controller] = poolMarketCapFactor.toString();
            }
        } else {
            // Shared pool
            for (const holder of shareHolders) {
                let userBalanceWei = await bPool.methods
                    .balanceOf(holder)
                    .call(undefined, i);
                let userBalance = utils.scale(userBalanceWei, -18);
                let userPoolValue = userBalance
                    .div(bptSupply)
                    .times(poolMarketCap)
                    .dp(18);
                let userPoolValueFactor = userBalance
                    .div(bptSupply)
                    .times(poolMarketCapFactor)
                    .dp(18);

                if (userPools[holder]) {
                    userPools[holder].push({
                        pool: poolAddress,
                        feeFactor: feeFactor.toString(),
                        ratioFactor: ratioFactor.toString(),
                        valueUSD: userPoolValue.toString(),
                        factorUSD: userPoolValueFactor.toString(),
                    });
                } else {
                    userPools[holder] = [
                        {
                            pool: poolAddress,
                            feeFactor: feeFactor.toString(),
                            ratioFactor: ratioFactor.toString(),
                            valueUSD: userPoolValue.toString(),
                            factorUSD: userPoolValueFactor.toString(),
                        },
                    ];
                }

                // Add this pool liquidity to total user liquidity
                if (userLiquidity[holder]) {
                    userLiquidity[holder] = bnum(userLiquidity[holder])
                        .plus(userPoolValueFactor)
                        .toString();
                } else {
                    userLiquidity[holder] = userPoolValueFactor.toString();
                }
            }
        }

        poolProgress.increment(1);
    }

    // Final iteration across all users to calculate their BAL tokens for this block
    let userBalReceived = {};
    let balDistributedDoubleCheck = bnum(0);
    for (const user in userLiquidity) {
        userBalReceived[user] = bnum(userLiquidity[user])
            .times(BAL_PER_SNAPSHOT)
            .div(totalBalancerLiquidity);
    }

    return [userPools, userBalReceived];
}

(async function () {
    const multibar = new cliProgress.MultiBar(
        {
            clearOnComplete: false,
            format:
                '[{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {task}',
        },
        cliProgress.Presets.shades_classic
    );

    !fs.existsSync(`./reports/${WEEK}/`) && fs.mkdirSync(`./reports/${WEEK}/`);

    let startBlockTimestamp = (await web3.eth.getBlock(START_BLOCK)).timestamp;
    let endBlockTimestamp = (await web3.eth.getBlock(END_BLOCK)).timestamp;

    let pools = await utils.fetchPublicSwapPools();
    const allTokens = pools.flatMap((a) => a.tokensList);

    const priceProgress = multibar.create(allTokens.length, 0, {
        task: 'Fetching Prices',
    });

    let prices = {};

    if (fs.existsSync(`./reports/${WEEK}/_prices.json`)) {
        const jsonString = fs.readFileSync(`./reports/${WEEK}/_prices.json`);
        prices = JSON.parse(jsonString);
    } else {
        prices = await utils.fetchTokenPrices(
            allTokens,
            startBlockTimestamp,
            endBlockTimestamp,
            priceProgress
        );
        let path = `/${WEEK}/_prices`;
        utils.writeData(prices, path);
    }

    const poolProgress = multibar.create(pools.length, 0, {
        task: 'Block Progress',
    });
    const blockProgress = multibar.create(END_BLOCK - START_BLOCK, 0, {
        task: 'Overall Progress',
    });

    for (i = END_BLOCK; i > START_BLOCK; i -= BLOCKS_PER_SNAPSHOT) {
        if (i >= 10238971) {
            blockProgress.increment(BLOCKS_PER_SNAPSHOT);
            continue;
        }
        let blockRewards = await getRewardsAtBlock(
            i,
            pools,
            prices,
            poolProgress
        );
        let path = `/${WEEK}/${i}`;
        utils.writeData(blockRewards, path);
        blockProgress.increment(BLOCKS_PER_SNAPSHOT);
    }

    blockProgress.stop();
})();
