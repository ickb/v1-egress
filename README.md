# iCKB v1 bot

## Run the limit order fulfillment bot on testnet

1. Download this repo in a folder of your choice:  

```bash
git clone https://github.com/ickb/v1-bot.git
```

2. Enter into the repo folder:

```bash
cd v1-bot
```

3. Install dependencies:

```bash
npm i
```

4. Define a `env/testnet/.env` file, for example:

```
CHAIN=testnet
BOT_PRIVATE_KEY=0x-YOUR-SECP256K1-BLAKE160-PRIVATE-KEY
FUNDING_PRIVATE_KEY=0x-YOUR-FUNDING-SECP256K1-BLAKE160-PRIVATE-KEY
```

5. Start matching user limit orders:

```bash
npm run start --chain=testnet
```

## Licensing

The license for this repository is the MIT License, see the [`LICENSE`](./LICENSE).
