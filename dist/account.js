"use strict";
// Downloaded as it is from:
// https://raw.githubusercontent.com/ckb-js/lumos/develop/packages/e2e-test/src/utils.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.randomSecp256k1Account = exports.asyncSleep = exports.generateRandomPrivateKey = void 0;
const helpers_1 = require("@ckb-lumos/helpers");
const crypto_1 = require("crypto");
const hd_1 = require("@ckb-lumos/hd");
const config_manager_1 = require("@ckb-lumos/config-manager");
const bytes_1 = require("@ckb-lumos/codec/lib/bytes");
// secp256k1 private key is 32-bytes length
const generateRandomPrivateKey = () => (0, bytes_1.hexify)((0, crypto_1.randomBytes)(32));
exports.generateRandomPrivateKey = generateRandomPrivateKey;
function asyncSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
exports.asyncSleep = asyncSleep;
const randomSecp256k1Account = (privKey) => {
    const _privKey = (() => {
        if (privKey) {
            return privKey;
        }
        return (0, exports.generateRandomPrivateKey)();
    })();
    const pubKey = hd_1.key.privateToPublic(_privKey);
    const args = hd_1.key.publicKeyToBlake160(pubKey);
    const template = (0, config_manager_1.getConfig)().SCRIPTS["SECP256K1_BLAKE160"];
    const lockScript = {
        codeHash: template.CODE_HASH,
        hashType: template.HASH_TYPE,
        args: args,
    };
    const address = (0, helpers_1.encodeToAddress)(lockScript);
    return {
        lockScript,
        address,
        pubKey,
        privKey: _privKey,
    };
};
exports.randomSecp256k1Account = randomSecp256k1Account;
//# sourceMappingURL=account.js.map