import { Config } from "@ckb-lumos/config-manager";
import { BI } from "@ckb-lumos/bi";
import {
    Assets, I8Cell, I8Header, I8Script, addCells, capacitySifter, ckbDelta, ckbFundAdapter, errorNotEnoughFunds,
    errorTooManyOutputs, fund, getCells, getChainInfo, getFeeRate, getHeaderByNumber, getTipHeader,
    initializeChainAdapter, isChain, isDaoDeposit, isDaoWithdrawalRequest, secp256k1Blake160, sendTransaction
} from "@ickb/lumos-utils";
import {
    ICKB_SOFT_CAP_PER_DEPOSIT, LimitOrder, ckb2Ickb, ckbSoftCapPerDeposit, ickb2Ckb, ickbDelta, ickbDeposit,
    ickbLogicScript, ickbRequestWithdrawalWith, ickbSifter, ickbSudtFundAdapter, limitOrder
} from "@ickb/v1-core";
import { TransactionSkeleton, TransactionSkeletonType } from "@ckb-lumos/helpers";
import { Cell, Hexadecimal, OutPoint } from "@ckb-lumos/base";
import memoize from "sonic-memoize";

async function main() {
    const { CHAIN, RPC_URL, CLIENT_TYPE, BOT_PRIVATE_KEY } = process.env;
    if (!isChain(CHAIN)) {
        throw Error("Invalid env CHAIN: " + CHAIN);
    }
    if (CHAIN === "mainnet") {
        throw Error("Not yet ready for mainnet...")
    }
    if (!BOT_PRIVATE_KEY) {
        throw Error("Empty env BOT_PRIVATE_KEY")
    }
    const config: Config = await import(`../env/${CHAIN}/config.json`);
    await initializeChainAdapter(CHAIN, config, RPC_URL, CLIENT_TYPE === "light" ? true : undefined);

    const botAccount = secp256k1Blake160(BOT_PRIVATE_KEY);
    const limitOrderInfo = limitOrder();

    const {
        capacities,
        sudts, receiptGroups, ickbDepositPool,
        ckb2SudtOrders, sudt2ckbOrders
    } = await siftCells(botAccount, limitOrderInfo);

    const tipHeader = await getTipHeader();
    const feeRate = await getFeeRate();

    let assets = ckbFundAdapter(botAccount.lockScript, feeRate, botAccount.preSigner, capacities);
    assets = ickbSudtFundAdapter(assets, botAccount.lockScript, sudts, tipHeader, receiptGroups);

    console.log(
        "CKB :",
        assets["CKB"].availableBalance.div(100000000).toString(),
        "+",
        assets["CKB"].balance.sub(assets["CKB"].availableBalance).div(100000000).toString()
    );

    console.log(
        "ICKB:",
        assets["ICKB_SUDT"].availableBalance.div(100000000).toString(),
        "+",
        assets["ICKB_SUDT"].balance.sub(assets["ICKB_SUDT"].availableBalance).div(100000000).toString()
    );

    const totalBalance = ickb2Ckb(assets["ICKB_SUDT"].balance, tipHeader).add(assets["CKB"].balance);
    const fiveDeposits = ckbSoftCapPerDeposit(tipHeader).mul(5)
    if (totalBalance.lt(fiveDeposits)) {
        console.log();
        console.log(`${totalBalance.div(100000000).toString()} CKB < ${fiveDeposits.div(100000000).toString()} CKB`);
        console.log("Warning: the total bot balance is lower than five standard deposits!!");
        console.log("The bot may not be able to properly match orders.");
        console.log();
    }

    function calculateGain(tx: TransactionSkeletonType) {
        if (tx.inputs.size === 0 && tx.outputs.size === 0) {
            return BI.from(0);
        }

        const gain = ickb2Ckb(ickbDelta(tx), tipHeader).add(ckbDelta(tx, 0));
        return rebalanceAndFund(tx, assets, ickbDepositPool, tipHeader) ? gain : negInf;
    }

    let tx = bestPartialFilling(limitOrderInfo, ckb2SudtOrders, sudt2ckbOrders, tipHeader, calculateGain);;
    //Re-balance holding between CKB and iCKB
    let fundedTx = rebalanceAndFund(tx, assets, ickbDepositPool, tipHeader);
    if (!fundedTx) {
        return
    }

    // console.log(JSON.stringify(fundedTx, undefined, 2));
    fundedTx.inputs.filter(limitOrderInfo.isValid).forEach(() => console.log("Limit Order Matched"));
    fundedTx.outputs.filter(isDaoDeposit).forEach(() => console.log("Deposit"));
    fundedTx.outputs.filter(isDaoWithdrawalRequest).forEach(() => console.log("Withdrawal Request"));
    fundedTx.inputs.filter(isDaoWithdrawalRequest).forEach(() => console.log("Withdrawal"));

    const txHash = await sendTransaction(botAccount.signer(fundedTx));
    console.log(txHash);
}

const negInf = BI.from(0).sub(BI.from(1).shl(64));

function bestPartialFilling(
    limitOrderInfo: ReturnType<typeof limitOrder>,
    ckb2SudtOrders: LimitOrder[],
    sudt2ckbOrders: LimitOrder[],
    tipHeader: I8Header,
    calculateGain: (tx: TransactionSkeletonType) => BI
) {
    const aPartials = partials(limitOrderInfo, ckb2SudtOrders, ckbSoftCapPerDeposit(tipHeader));
    const bPartials = partials(limitOrderInfo, sudt2ckbOrders, ICKB_SOFT_CAP_PER_DEPOSIT);
    const from = memoize(function (aIndex: number, bIndex: number) {
        let tx = TransactionSkeleton();
        let gain = negInf;
        const a = aPartials[aIndex];
        const b = bPartials[bIndex];
        if (!a || !b) {
            return { aIndex, bIndex, tx, gain };
        }

        tx = addCells(tx, "matched", a.orders.concat(b.orders), a.fulfillments.concat(b.fulfillments));
        gain = calculateGain(tx);
        return { aIndex, bIndex, tx, gain };
    });

    let fresh = from(0, 0);
    let old: typeof fresh | undefined = undefined;
    while (old !== fresh) {
        old = fresh;
        fresh = [
            from(fresh.aIndex, fresh.bIndex),
            from(fresh.aIndex, fresh.bIndex + 1),
            from(fresh.aIndex + 1, fresh.bIndex),
            from(fresh.aIndex + 1, fresh.bIndex + 1)
        ].reduce((a, b) => a.gain.gt(b.gain) ? a : b);
    }

    // console.log(fresh.aIndex, fresh.bIndex, fresh.gain.div(100000000).toString());

    return fresh.tx;
}

function partials(
    limitOrderInfo: ReturnType<typeof limitOrder>,
    origin: LimitOrder[],
    allowanceStep: BI,
) {
    let orders: readonly I8Cell[] = Object.freeze([]);
    let completedOrders: readonly I8Cell[] = Object.freeze([]);
    let fulfillments: readonly I8Cell[] = Object.freeze([]);

    const res = [{ orders, fulfillments }];

    for (const o of origin) {
        let sudtAllowance = BI.from(0);
        let ckbAllowance = BI.from(0);

        let fulfillment: I8Cell;
        let isComplete = false;
        orders = Object.freeze(orders.concat([o.cell]));
        while (!isComplete) {
            ckbAllowance = ckbAllowance.add(allowanceStep);
            sudtAllowance = sudtAllowance.add(allowanceStep);

            ({ fulfillment, isComplete } = limitOrderInfo.satisfy(o, ckbAllowance, sudtAllowance));
            fulfillments = Object.freeze(completedOrders.concat([fulfillment]));

            res.push({ orders, fulfillments });
        }
        completedOrders = fulfillments;
    }

    return res;
}

async function siftCells(
    botAccount: ReturnType<typeof secp256k1Blake160>,
    limitOrderInfo: ReturnType<typeof limitOrder>
) {
    const cells = (await Promise.all([
        getCells({
            script: botAccount.lockScript,
            scriptType: "lock",
            scriptSearchMode: "exact"
        }),
        getCells({
            script: ickbLogicScript(),
            scriptType: "lock",
            scriptSearchMode: "exact"
        }),
        getCells({
            script: limitOrderInfo.limitOrderLock,
            scriptType: "lock",
            scriptSearchMode: "prefix"
        })
    ])).flat();

    const { capacities, notCapacities } = capacitySifter(cells, botAccount.expander);
    const {
        sudts,
        receiptGroups,
        ickbDepositPool,
        notIckbs
    } = await myIckbSifter(notCapacities, botAccount.expander);
    const { ckb2SudtOrders, sudt2ckbOrders } = limitOrderInfo.sifter(notIckbs, undefined, "asc");

    return {
        capacities,
        sudts, receiptGroups, ickbDepositPool,
        ckb2SudtOrders, sudt2ckbOrders
    }
}

function rebalanceAndFund(
    tx: TransactionSkeletonType,
    assets: Assets,
    ickbDepositPool: readonly I8Cell[],
    tipHeader: I8Header
) {
    //Balance should be after the current transaction, so it should account for transaction cells
    const a = Object.freeze(//after Tx Balances
        Object.fromEntries(
            Object.entries(assets).map(([name, { balance, availableBalance, getDelta }]) => {
                const delta = getDelta(tx);
                return [name, Object.freeze({
                    balance: balance.add(delta),
                    availableBalance: availableBalance.add(delta)
                })];
            })
        )
    );

    for (const [_, { availableBalance }] of Object.entries(a)) {
        if (availableBalance.lt(0)) {
            return undefined;
        }
    }

    const { chain } = getChainInfo();
    const minLock = chain === "devnet" ? undefined : { length: 16, index: 1, number: 0 };// 1/8 epoch (~ 15 minutes)
    const maxLock = chain === "devnet" ? undefined : { length: 4, index: 1, number: 0 };// 1/4 epoch (~ 1 hour)

    // For simplicity a transaction containing Nervos DAO script is currently limited to 64 output cells
    // so that processing is simplified, this limitation may be relaxed later on in a future Nervos DAO script update.
    //58 = 64 - 6, 6 are the estimated change cells added later
    const daoLimit = 58 - tx.outputs.size;

    //Keep most balance in SUDT
    //Ideally keep a CKB balance between one and three deposits, with two deposits being the perfect spot
    const ckbBalance = a["CKB"].balance;
    const softCapPerDeposit = ckbSoftCapPerDeposit(tipHeader);
    if (daoLimit <= 0) {
        //Do nothing...
    } else if (ckbBalance.lt(softCapPerDeposit.mul(2))) {
        const maxWithdrawAmount = ckb2Ickb(softCapPerDeposit.mul(2).sub(ckbBalance), tipHeader);
        tx = ickbRequestWithdrawalWith(tx, ickbDepositPool, tipHeader, maxWithdrawAmount, daoLimit, minLock, maxLock);
    } else if (ckbBalance.gt(softCapPerDeposit.mul(3))) {
        const deposits = ckbBalance.div(softCapPerDeposit).sub(2).toNumber();
        tx = ickbDeposit(tx, deposits < daoLimit ? deposits : daoLimit, tipHeader);
    }

    // //Keep most balance in CKB
    // //Ideally keep a SUDT balance between one and three deposits, with two deposits being the perfect spot
    // const ickbBalance = a["ICKB_SUDT"].balance;
    // if (daoLimit <= 0) {
    //     //Do nothing...
    // } else if (ickbBalance.lt(ICKB_SOFT_CAP_PER_DEPOSIT)) {
    //     //One deposit for each transaction
    //     tx = ickbDeposit(tx, 1, tipHeader);
    // } else if (ickbBalance.gt(ICKB_SOFT_CAP_PER_DEPOSIT.mul(3))) {
    //     const ickbExcess = ickbBalance.sub(ICKB_SOFT_CAP_PER_DEPOSIT.mul(2));
    //     tx = ickbRequestWithdrawalWith(tx, ickbDepositPool, tipHeader, ickbExcess, minLock, maxLock);
    // }

    if (tx.outputs.size === 0) {
        return undefined;
    }

    try {
        return fund(tx, assets, true);
    } catch (e: any) {
        if (e && (e.message === errorNotEnoughFunds || e.message === errorTooManyOutputs)) {
            return undefined;
        }
        throw e;
    }

}

const headerPlaceholder = I8Header.from({
    compactTarget: "0x1a08a97e",
    parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionsRoot: "0x31bf3fdf4bc16d6ea195dbae808e2b9a8eca6941d589f6959b1d070d51ac28f7",
    proposalsHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    extraHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    dao: "0x8874337e541ea12e0000c16ff286230029bfa3320800000000710b00c0fefe06",
    epoch: "0x0",
    hash: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
    nonce: "0x0",
    number: "0x0",
    timestamp: "0x16e70e6985c",
    version: "0x0"
});
let _blockNum2Header = new Map<string, I8Header>();
async function myIckbSifter(inputs: readonly Cell[], accountLockExpander: (c: Cell) => I8Script | undefined) {
    function attemptIckbSifting() {
        let allHeadersFound = true;
        const queries: { blockNum: Hexadecimal, context: OutPoint }[] = [];
        function getHeader(blockNumber: string, context: Cell): I8Header {
            queries.push({ blockNum: blockNumber, context: context.outPoint! });
            let h = _blockNum2Header.get(blockNumber);
            if (!h) {
                h = headerPlaceholder;
                allHeadersFound = false;
            }
            return h;
        }
        const ickbSifterResult = ickbSifter(inputs, accountLockExpander, getHeader);
        return {
            ickbSifterResult,
            allHeadersFound,
            queries
        }
    }

    let r = attemptIckbSifting();
    if (r.allHeadersFound) {
        return r.ickbSifterResult;
    }

    //Fetch wanted headers from L1
    const headers = await getHeaderByNumber(r.queries, Array.from(_blockNum2Header.values()));
    _blockNum2Header = new Map(headers.map(h => [h.number, h]));

    r = attemptIckbSifting();
    if (r.allHeadersFound) {
        return r.ickbSifterResult;
    }

    throw Error("Unable to get some headers");
}

main();