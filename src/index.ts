import config from "./config.json";
import { Config } from "@ckb-lumos/config-manager";
import { parseUnit } from "@ckb-lumos/bi";
import {
    Assets, I8Cell, I8Header, I8Script, capacitySifter, ckbFundAdapter, errorNotEnoughFunds,
    fund, genesisDevnetKey, getCells, getFeeRate, getHeaderByNumber, getTipHeader, initializeChainAdapter,
    isChain, isDaoDeposit, isDaoWithdrawalRequest, secp256k1Blake160, sendTransaction, shuffle
} from "@ickb/lumos-utils";
import {
    ICKB_SOFT_CAP_PER_DEPOSIT, ickbDeposit, ickbLogicScript, ickbRequestWithdrawalWith, ickbSifter,
    ickbSudtFundAdapter, limitOrder
} from "@ickb/v1-core";
import { TransactionSkeleton, TransactionSkeletonType } from "@ckb-lumos/helpers";
import { Cell, Hexadecimal, OutPoint } from "@ckb-lumos/base";

//ADD some checks for initial bot capital

async function main() {
    const args = process.argv.slice(2);
    const [chain, rpcUrl, clientType] = args;

    if (args.length < 1 || args.length > 3
        || !isChain(chain)
        || !(clientType in clientType2IsLightClient)) {
        throw Error("Invalid command line arguments " + args.join(" "));
    }

    await initializeChainAdapter(chain, config as Config, rpcUrl, clientType2IsLightClient[clientType]);

    if (chain === "mainnet") {
        throw Error("Not yet ready for mainnet...")
    }

    const testingBotKey = "0xd4a18c9653909588b71551a641a6fed44f2893c9a81f8b46998582a6c98fc5a0";
    let botAccount = secp256k1Blake160(testingBotKey);
    const limitOrderInfo = limitOrder();

    const {
        capacities,
        sudts, receiptGroups, ickbDepositPool,
        ckb2SudtOrders, sudt2ckbOrders
    } = await siftCells(botAccount, limitOrderInfo);

    if (capacities.length === 0 && sudts.length === 0) {
        console.log("Funding bot");
        const genesisAccount = secp256k1Blake160(genesisDevnetKey);
        const txHash = await genesisAccount.transfer(botAccount.lockScript, parseUnit("1000000", "ckb"));
        console.log(txHash);
        return;
    }

    const tipHeader = await getTipHeader();
    const feeRate = await getFeeRate();

    let assets = ckbFundAdapter(botAccount.lockScript, feeRate, botAccount.preSigner, capacities);
    assets = ickbSudtFundAdapter(assets, botAccount.lockScript, sudts, tipHeader, receiptGroups);

    console.log("CKB :", assets["CKB"].balance.div(100000000).toString());
    console.log("ICKB:", assets["ICKB_SUDT"].balance.div(100000000).toString());

    let tx = TransactionSkeleton();
    let fundedTx = rebalanceAndFund(tx, assets, ickbDepositPool, tipHeader);

    for (const order of shuffle([...ckb2SudtOrders, ...sudt2ckbOrders])) {
        tx = limitOrderInfo.fulfill(tx, order, undefined, undefined);
        //Re-balance holding between CKB and iCKB
        let newFundedTx = rebalanceAndFund(tx, assets, ickbDepositPool, tipHeader);
        if (!newFundedTx) {
            break
        }
        fundedTx = newFundedTx;
    }
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
    const { ckb2SudtOrders, sudt2ckbOrders } = limitOrderInfo.sifter(notIckbs);

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

    //Ideally keep a SUDT balance between one and three deposits, with two deposits being the perfect spot
    const ickbBalance = a["ICKB_SUDT"].balance;
    if (ickbBalance.lt(ICKB_SOFT_CAP_PER_DEPOSIT)) {
        //One deposit for each transaction
        tx = ickbDeposit(tx, 1, tipHeader);
    } else if (ickbBalance.gt(ICKB_SOFT_CAP_PER_DEPOSIT.mul(3))) {
        const ickbExcess = ickbBalance.sub(ICKB_SOFT_CAP_PER_DEPOSIT.mul(2));
        tx = ickbRequestWithdrawalWith(tx, ickbDepositPool, tipHeader, ickbExcess);
    }

    if (tx.outputs.size === 0) {
        return undefined;
    }

    try {
        return fund(tx, assets, true);
    } catch (e: any) {
        if (e && e.message === errorNotEnoughFunds) {
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
    while (true) {//Dangerous/////////////////////////////////////////////////////////////////////////////////
        const queries: { blockNum: Hexadecimal, context: OutPoint }[] = [];
        let missingHeaders = false;
        function getHeader(blockNumber: string, context: Cell): I8Header {
            queries.push({ blockNum: blockNumber, context: context.outPoint! });
            let h = _blockNum2Header.get(blockNumber);
            if (!h) {
                h = headerPlaceholder;
                missingHeaders = true;
            }
            return h;
        }

        const result = ickbSifter(inputs, accountLockExpander, getHeader);
        if (!missingHeaders) {
            return result;
        }

        //Discard result, just fetch wanted headers
        const headers = await getHeaderByNumber(queries, Array.from(_blockNum2Header.values()));
        _blockNum2Header = new Map(headers.map(h => [h.number, h]));
    }
}

const clientType2IsLightClient: { [id: string]: boolean } = {
    "light": true,
    "full": false,
    undefined: false
};

main();