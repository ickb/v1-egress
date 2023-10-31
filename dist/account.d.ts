import { Script } from "@ckb-lumos/base";
export declare const generateRandomPrivateKey: () => string;
export declare function asyncSleep(ms: number): Promise<unknown>;
export interface Account {
    lockScript: Script;
    address: string;
    pubKey: string;
    privKey: string;
}
export declare const randomSecp256k1Account: (privKey?: string) => Account;
//# sourceMappingURL=account.d.ts.map