"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const lumos_utils_1 = require("lumos-utils");
const v1_core_1 = require("v1-core");
const config_json_1 = __importDefault(require("./config.json"));
const bi_1 = require("@ckb-lumos/bi");
const account_1 = require("./account");
async function main() {
    await (0, lumos_utils_1.initializeChainAdapter)("devnet", config_json_1.default);
    const rpc = (0, lumos_utils_1.getRpc)();
    const indexer = await (0, lumos_utils_1.getSyncedIndexer)();
    // const { create, sudtHash } = newLimitOrderUtils();
    //Genesis account
    const genesisAccount = (0, account_1.randomSecp256k1Account)("0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc");
    //Bot account
    const botAccount = (0, account_1.randomSecp256k1Account)();
    const newTransactionBuilder = (account) => new v1_core_1.IckbTransactionBuilder(account.lockScript, (0, lumos_utils_1.secp256k1SignerFrom)(account.privKey));
    const { txHash: botFundingTx } = await (await (0, v1_core_1.fund)(newTransactionBuilder(genesisAccount)
        .add("output", "end", {
        cellOutput: {
            capacity: (0, bi_1.parseUnit)("1000000", "ckb").toHexString(),
            lock: botAccount.lockScript,
            type: undefined,
        },
        data: "0x"
    }))).buildAndSend();
    console.log("Bot funded with " + botFundingTx);
    const { txHash: depositTx } = await (await (0, v1_core_1.fund)((0, v1_core_1.deposit)(newTransactionBuilder(botAccount), 5, (0, bi_1.parseUnit)("100000", "ckb")))).buildAndSend();
    console.log("Bot deposit half of the funds with " + depositTx);
    const depositAtIndex0 = await (0, lumos_utils_1.getLiveCell)({ txHash: depositTx, index: "0x0" });
    const { txHash: withdrawalRequest } = await (await (0, v1_core_1.fund)((0, v1_core_1.withdrawFrom)(newTransactionBuilder(botAccount), depositAtIndex0))).buildAndSend();
    console.log("Bot withdraw first deposit " + withdrawalRequest);
    const withdrawalRequestAtIndex0 = await (0, lumos_utils_1.getLiveCell)({ txHash: withdrawalRequest, index: "0x0" });
    while (true) {
        const b = newTransactionBuilder(botAccount);
        const tipEpoch = (0, lumos_utils_1.parseEpoch)((await (0, lumos_utils_1.getRpc)().getTipHeader()).epoch);
        const maturityEpoch = (0, lumos_utils_1.parseEpoch)(await b.withdrawedDaoSince(withdrawalRequestAtIndex0));
        if ((0, lumos_utils_1.epochCompare)(maturityEpoch, tipEpoch) < 1) { //Withdrawal request is ripe
            break;
        }
        console.log("Waiting 10 seconds...");
        await (0, account_1.asyncSleep)(10000);
    }
    const { txHash: botSelfSendTx } = await (await (0, v1_core_1.fund)(newTransactionBuilder(botAccount)
        .add("output", "end", {
        cellOutput: {
            capacity: (0, bi_1.parseUnit)("1000", "ckb").toHexString(),
            lock: botAccount.lockScript,
            type: undefined,
        },
        data: "0x"
    }))).buildAndSend();
    console.log("Bot botSelfSendTx " + botSelfSendTx);
}
main();
//# sourceMappingURL=index.js.map