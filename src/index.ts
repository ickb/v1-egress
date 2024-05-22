import type { Cell, Hexadecimal, OutPoint } from "@ckb-lumos/base";
import { TransactionSkeleton, } from "@ckb-lumos/helpers";
import type { TransactionSkeletonType } from "@ckb-lumos/helpers";
import {
    addCells, addCkbAsset, addSimpleCells, capacitySifter, CKB, ckbDelta, ckbMark, errorNotEnoughFunds,
    errorTooManyOutputs, fund, getCells, getChainInfo, getFeeRate, getHeaderByNumber, getTipHeader,
    hex, I8Cell, I8Header, initializeChainAdapter, isChain, isDaoDeposit, isDaoWithdrawalRequest,
    scriptEq, secp256k1Blake160, sendTransaction
} from "@ickb/lumos-utils";
import type { Assets, I8Script } from "@ickb/lumos-utils";
import {
    ICKB_SOFT_CAP_PER_DEPOSIT, addIckbAsset, addOrders, addWithdrawalRequestGroups, ckb2Ickb, ckb2UdtRatioCompare,
    ckbSoftCapPerDeposit, errorAllowanceTooLow, getIckbScriptConfigs, ickb2Ckb, ickbDelta, ickbDeposit,
    ickbExchangeRatio, ickbLogicScript, ickbMark, ickbRequestWithdrawalWith, ickbSifter, limitOrderScript,
    orderSatisfy, orderSifter, ownedOwnerScript, udt2CkbRatioCompare
} from "@ickb/v1-core";
import type { Order } from "@ickb/v1-core";

async function main() {
    const { CHAIN, RPC_URL, CLIENT_TYPE, BOT_PRIVATE_KEY, BOT_SLEEP_INTERVAL } = process.env;
    if (!isChain(CHAIN)) {
        throw Error("Invalid env CHAIN: " + CHAIN);
    }
    if (CHAIN === "mainnet") {
        throw Error("Not yet ready for mainnet...")
    }
    if (!BOT_PRIVATE_KEY) {
        throw Error("Empty env BOT_PRIVATE_KEY")
    }
    if (!BOT_SLEEP_INTERVAL || Number(BOT_SLEEP_INTERVAL) < 1) {
        throw Error("Invalid env BOT_SLEEP_INTERVAL")
    }

    await initializeChainAdapter(CHAIN, RPC_URL, CLIENT_TYPE === "light" ? true : undefined, getIckbScriptConfigs);
    const account = secp256k1Blake160(BOT_PRIVATE_KEY);
    const sleepInterval = Number(BOT_SLEEP_INTERVAL) * 1000;

    const orderScript = limitOrderScript();

    while (true) {
        let executionLog: any = {};
        let startTime = new Date();
        executionLog.startTime = startTime.toLocaleString();
        try {
            const {
                capacities, udts, receipts, withdrawalRequestGroups, ickbDepositPool, orders, myOrders
            } = await siftCells(account);

            const tipHeader = await getTipHeader();
            const feeRate = await getFeeRate();
            const minChange = 0n;//Use minChange as relevant instead of setApartEmergencyCKB ////////////////////////

            let assets = addCkbAsset({}, account.lockScript, feeRate, account.preSigner, minChange);
            assets = addIckbAsset(assets, account.lockScript);
            assets = addSimpleCells(assets, capacities, udts, receipts);
            assets = addWithdrawalRequestGroups(assets, withdrawalRequestGroups, tipHeader);
            assets = addOrders(assets, myOrders);

            executionLog.balance = {
                "CKB": {
                    total: fmtCkb(assets[ckbMark].estimated),
                    available: fmtCkb(assets[ckbMark].estimatedAvailable),
                    unavailable: fmtCkb(assets[ckbMark].estimated - assets[ckbMark].estimatedAvailable),
                }, "ICKB": {
                    total: fmtCkb(assets[ickbMark].estimated),
                    available: fmtCkb(assets[ickbMark].estimatedAvailable),
                    unavailable: fmtCkb(assets[ickbMark].estimated - assets[ickbMark].estimatedAvailable),
                }, "totalEquivalent": {
                    "CKB": fmtCkb(assets[ckbMark].estimated + ickb2Ckb(assets[ickbMark].estimated, tipHeader)),
                    "ICKB": fmtCkb(ckb2Ickb(assets[ckbMark].estimated, tipHeader) + assets[ickbMark].estimated),
                }
            };
            executionLog.ratio = ickbExchangeRatio(tipHeader);

            function evaluate(combination: Combination): Combination {
                let { i, j, tx } = combination;
                let fundedTx = rebalanceAndFund(tx, assets, ickbDepositPool, tipHeader, account.lockScript);
                let gain = ickb2Ckb(ickbDelta(tx), tipHeader) + ckbDelta(tx, 0n);
                gain = i == 0 && j == 0 ? 0n : !fundedTx ? negInf : gain - 3n * ckbDelta(fundedTx, 0n);
                return { ...combination, fundedTx, gain }
            }

            let { fundedTx: tx } = bestPartialFilling(
                orders,
                evaluate,
                ckbSoftCapPerDeposit(tipHeader) / 10n,
                ICKB_SOFT_CAP_PER_DEPOSIT / 10n
            );
            if (tx) {
                // console.log(JSON.stringify(tx, undefined, 2));
                executionLog.actions = {
                    matchedOrders: tx.inputs.filter(c => scriptEq(c.cellOutput.lock, orderScript)).size,
                    deposits: tx.outputs.filter(isDaoDeposit).size,
                    withdrawalRequests: tx.outputs.filter(isDaoWithdrawalRequest).size,
                    withdrawals: tx.inputs.filter(isDaoWithdrawalRequest).size,
                };
                executionLog.txFee = {
                    fee: fmtCkb(ckbDelta(tx, 0n)),
                    feeRate,
                };

                executionLog.txHash = await sendTransaction(account.signer(tx));
            }
        } catch (e: any) {
            if (e) {
                executionLog.error = { ...e, stack: e.stack ?? "" };
            } else {
                executionLog.message = "Empty";
            }
        }
        executionLog.ElapsedSeconds = Math.round((new Date().getTime() - startTime.getTime()) / 1000);
        console.log(JSON.stringify(executionLog, replacer, " ") + ",");

        await new Promise(r => setTimeout(r, sleepInterval));
    }
}

function fmtCkb(b: bigint) {
    return Number(b) / Number(CKB);
}

function replacer(_: unknown, value: unknown) {
    return typeof value === "bigint" ? Number(value) : value
};

const negInf = -1n * (1n << 64n);

type Combination = {
    i: number,
    j: number,
    tx: TransactionSkeletonType,
    fundedTx: TransactionSkeletonType | undefined,
    gain: bigint
};

function bestPartialFilling(
    orders: Order[],
    evaluate: (tx: Combination) => Combination,
    ckbAllowanceStep: bigint,
    udtAllowanceStep: bigint,
) {
    const ckb2UdtPartials = partialsFrom(orders, true, udtAllowanceStep);
    const udt2CkbPartials = partialsFrom(orders, false, ckbAllowanceStep);

    const alreadyVisited = new Map<string, Combination>();
    const from = (i: number, j: number): Combination => {
        let key = `${i}-${j}`;
        let cached = alreadyVisited.get(key);
        if (cached) {
            return cached;
        }
        let result: Combination = { i, j, tx: TransactionSkeleton(), fundedTx: undefined, gain: negInf };
        const iom = ckb2UdtPartials[i];
        const jom = udt2CkbPartials[j];
        if (iom && jom) {
            const origins = iom.origins.concat(jom.origins);
            const matches = iom.matches.concat(jom.matches)
            result.tx = addCells(result.tx, "append", origins, matches);
            result = evaluate(result);
        }
        alreadyVisited.set(key, Object.freeze(result));
        return result;
    };

    let fresh = from(0, 0);
    let old: typeof fresh | undefined = undefined;
    while (old !== fresh) {
        old = fresh;
        fresh = [
            from(fresh.i, fresh.j),
            from(fresh.i, fresh.j + 1),
            from(fresh.i + 1, fresh.j),
            from(fresh.i + 1, fresh.j + 1)
        ].reduce((a, b) => a.gain > b.gain ? a : b);
    }

    // console.log(fresh.i, fresh.j, String(fresh.gain / CKB));

    return fresh;
}

function partialsFrom(
    orders: Order[],
    isCkb2Udt: boolean,
    allowanceStep: bigint,
) {
    let ckbAllowanceStep, udtAllowanceStep;
    if (isCkb2Udt) {
        ckbAllowanceStep = 0n;
        udtAllowanceStep = allowanceStep;
        orders = orders.filter(o => o.info.isCkb2UdtMatchable);
        orders.sort((o0, o1) => ckb2UdtRatioCompare(o0.info.ckbToUdt, o1.info.ckbToUdt));
    } else {
        ckbAllowanceStep = allowanceStep;
        udtAllowanceStep = 0n;
        orders = orders.filter(o => o.info.isUdt2CkbMatchable);
        orders.sort((o0, o1) => udt2CkbRatioCompare(o0.info.udtToCkb, o1.info.udtToCkb));
    }

    let origins: readonly I8Cell[] = Object.freeze([]);
    let fulfilled: readonly I8Cell[] = Object.freeze([]);
    let matches: readonly I8Cell[] = Object.freeze([]);

    const res = [{ origins, matches }];

    for (const o of orders) {
        try {
            let ckbAllowance = 0n;
            let udtAllowance = 0n;

            let match: I8Cell;
            let isFulfilled = false;

            let new_origins = Object.freeze(origins.concat([o.cell]));
            while (!isFulfilled) {
                ckbAllowance += ckbAllowanceStep;
                udtAllowance += udtAllowanceStep;

                ({ match, isFulfilled } = orderSatisfy(o, isCkb2Udt, ckbAllowance, udtAllowance));
                matches = Object.freeze(fulfilled.concat([match]));

                res.push({ origins: new_origins, matches });
            }

            origins = new_origins;
            fulfilled = matches;
        } catch (e: any) {
            // Skip orders whose ckbMinMatch is too high to be matched by base allowance Step
            if (!e || e.message !== errorAllowanceTooLow) {
                throw e;
            }
        }
    }

    return res;
}

async function siftCells(account: ReturnType<typeof secp256k1Blake160>) {
    const cells = (await Promise.all([
        getCells({
            script: account.lockScript,
            scriptType: "lock",
            scriptSearchMode: "exact"
        }),
        getCells({
            script: ickbLogicScript(),
            scriptType: "lock",
            scriptSearchMode: "exact"
        }),
        getCells({
            script: ownedOwnerScript(),
            scriptType: "lock",
            scriptSearchMode: "exact"
        }),
        getCells({
            script: limitOrderScript(),
            scriptType: "lock",
            scriptSearchMode: "prefix"
        })
    ])).flat();

    const { notCapacities, ...cells0 } = capacitySifter(cells, account.expander);
    const { notIckbs, ...cells1 } = await myIckbSifter(notCapacities, account.expander);
    const { notOrders, ...cells2 } = orderSifter(notIckbs, account.expander);

    return { ...cells0, ...cells1, ...cells2 };
}

function rebalanceAndFund(
    tx: TransactionSkeletonType,
    assets: Assets,
    ickbDepositPool: readonly I8Cell[],
    tipHeader: I8Header,
    accountLock: I8Script
): TransactionSkeletonType | undefined {
    //Balance should be after the current transaction, so it should account for transaction cells
    const a = Object.freeze(//after Tx Balances
        Object.fromEntries(
            Object.entries(assets).map(([name, { estimated, estimatedAvailable, getDelta }]) => {
                const delta = getDelta(tx);
                return [name, Object.freeze({
                    estimated: estimated + delta,
                    estimatedAvailable: estimatedAvailable + delta
                })];
            })
        )
    );

    for (const [_, { estimatedAvailable }] of Object.entries(a)) {
        if (estimatedAvailable < 0n) {
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
    const ckbBalance = a[ckbMark].estimated;
    const softCapPerDeposit = ckbSoftCapPerDeposit(tipHeader);
    let shouldSetApartEmergencyCKB = true;
    if (daoLimit <= 0) {
        //Do nothing...
    } else if (ckbBalance < softCapPerDeposit * 2n) {
        const maxWithdrawAmount = ckb2Ickb(softCapPerDeposit * 2n - ckbBalance, tipHeader);
        const new_tx = ickbRequestWithdrawalWith(
            tx, ickbDepositPool, tipHeader, maxWithdrawAmount, daoLimit, minLock, maxLock
        );
        if (new_tx.inputs.size != tx.inputs.size) {
            shouldSetApartEmergencyCKB = false;
        }
        tx = new_tx;
    } else if (ckbBalance > softCapPerDeposit * 3n) {
        const deposits = Number(ckbBalance / softCapPerDeposit) - 2;
        tx = ickbDeposit(tx, deposits < daoLimit ? deposits : daoLimit, tipHeader);
    }


    // //Keep most balance in CKB
    // //Ideally keep a SUDT balance between one and three deposits, with two deposits being the perfect spot
    // const ickbBalance = a[ickbMark].estimated;
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

    if (shouldSetApartEmergencyCKB) {
        tx = setApartEmergencyCKB(tx, accountLock);
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

function setApartEmergencyCKB(tx: TransactionSkeletonType, accountLock: I8Script) {
    let c = I8Cell.from({ lock: accountLock, capacity: hex(1000n * CKB) });
    return addCells(tx, "append", [], [c]);
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

// function withdrawEverything(
//     assets: Assets,
//     ickbDepositPool: readonly I8Cell[],
//     tipHeader: I8Header
// ) {
//     // For simplicity a transaction containing Nervos DAO script is currently limited to 64 output cells
//     // so that processing is simplified, this limitation may be relaxed in a future Nervos DAO script update.
//     //58 = 64 - 6, 6 are the estimated change cells added later
//     let tx = TransactionSkeleton();
//     const daoLimit = 58;
//     const maxWithdrawAmount = assets[ickbMark].estimatedAvailable;
//     tx = ickbRequestWithdrawalWith(tx, ickbDepositPool, tipHeader, maxWithdrawAmount, daoLimit);

//     try {
//         tx = fund(tx, assets, true);
//     } catch (e: any) {
//         if (e && (e.message === errorNotEnoughFunds || e.message === errorTooManyOutputs)) {
//             return undefined;
//         }
//         throw e;
//     }

//     // Check if the transaction is doing anything useful
//     if ([...tx.inputs, ...tx.outputs].some(isDao)) {
//         return tx;
//     }

//     return undefined;
// }

main();