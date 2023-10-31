import {
    defaultScript,
    epochCompare, getLiveCell, getRpc, getSyncedIndexer, initializeChainAdapter, parseEpoch, secp256k1SignerFrom
} from "lumos-utils";

import { IckbTransactionBuilder, fund, deposit, withdrawFrom, newLimitOrderUtils, ICKB_SOFT_CAP_PER_DEPOSIT, ckbSoftCapPerDeposit, ickbEquivalentValue } from "v1-core";

import config from "./config.json";
import { Config } from "@ckb-lumos/config-manager";
import { BI, parseUnit } from "@ckb-lumos/bi";
import { Account, asyncSleep, randomSecp256k1Account } from "./account";
import { CellCollector } from "@ckb-lumos/ckb-indexer";
import { Cell, Header } from "@ckb-lumos/base";

async function main() {
    await initializeChainAdapter("devnet", config as Config);
    const { fulfill } = newLimitOrderUtils();

    const botAccount = await createBot();

    const { txHash } = await (await rebalance(newTransactionBuilder(botAccount))).buildAndSend();

    console.log(txHash);

    console.log("Start matching orders")
    while (true) {
        await asyncSleep(1000);

        let tb = newTransactionBuilder(botAccount);

        //Assume the bot has infinitely big capital
        const unlimitedBalance = BI.from(10000000000000000000000000000000000000);
        for (const limitOrder of await getLimitOrders()) {
            const matched = fulfill(limitOrder, unlimitedBalance, unlimitedBalance)
            tb = tb.add("input", "start", limitOrder).add("output", "start", matched);
            console.log("Match limit order");
        }

        //Re-balance holding between CKB and iCKB
        tb = await rebalance(tb);

        if (tb.outputs.length > 0) {
            const { txHash } = await tb.buildAndSend();
            console.log(txHash);
        }
    }
}

async function getDeposits() {
    const indexer = await getSyncedIndexer();
    //Collect all deposits
    const res: Cell[] = [];
    for await (const deposit of new CellCollector(indexer, {
        scriptSearchMode: "exact",
        withData: true,
        type: defaultScript("DAO"),
        lock: defaultScript("DOMAIN_LOGIC")
    }).collect()) {
        res.push(deposit);
    }

    return res;
}

async function getLimitOrders() {
    const indexer = await getSyncedIndexer();
    const { extract } = newLimitOrderUtils();
    //Collect all limit orders
    const res: Cell[] = [];
    for await (const limitOrder of new CellCollector(indexer, {
        scriptSearchMode: "prefix",
        withData: true,
        lock: defaultScript("LIMIT_ORDER")
    }).collect()) {
        try {//Validate limit order
            extract(limitOrder);
            res.push(limitOrder);
        } catch {
            //Ignore limit order cell
        }
    }
    return res;
}

async function rebalance(tb: IckbTransactionBuilder) {
    const tipHeader = await getRpc().getTipHeader();
    tb = await fund(tb, true, tipHeader);
    const ickbDelta = await tb.getIckbDelta();
    const ckbDelta = await tb.getCkbDelta();
    const ickbEquivalentDelta = ickbEquivalentValue(ckbDelta, tipHeader);

    if (ickbDelta.lt(ickbEquivalentDelta)) {
        const ckbExcess = ickbEquivalentDelta.sub(ickbDelta).mul(ckbDelta).div(2).div(ickbEquivalentDelta);
        const depositAmount = ckbSoftCapPerDeposit(tipHeader);
        const depositQuantity = ckbExcess.div(depositAmount).toNumber();
        tb = deposit(tb, depositQuantity, depositAmount);
        for (let i = 0; i < depositQuantity; i++) {
            console.log("Deposit");
        }
    } else {
        for (const deposit of await getDeposits()) {
            const ickbDelta = await tb.getIckbDelta();
            const ckbDelta = await tb.getCkbDelta();
            const ickbEquivalentDelta = ickbEquivalentValue(ckbDelta, tipHeader);
            if (ickbDelta.lt(ickbEquivalentDelta)) {
                break;
            }
            tb = withdrawFrom(tb, deposit);
            console.log("Withdraw");
        }
    }

    return tb;
}

async function createBot() {
    console.log("Funding bot");
    //Genesis account
    const genesisAccount = randomSecp256k1Account("0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc");

    //Bot account
    const botAccount = randomSecp256k1Account();

    const { txHash } = await (
        await fund(
            newTransactionBuilder(genesisAccount)
                .add("output", "end", {
                    cellOutput: {
                        capacity: parseUnit("10000000", "ckb").toHexString(),// == max 50 deposits
                        lock: botAccount.lockScript,
                        type: undefined,
                    },
                    data: "0x"
                })
        )
    ).buildAndSend();
    console.log(txHash);

    return botAccount;
}

function newTransactionBuilder(account: Account) {
    return new IckbTransactionBuilder(
        account.lockScript,
        secp256k1SignerFrom(account.privKey)
    );
}

main();