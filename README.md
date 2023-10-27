# iCKB v1 bot

## Setup

### Run the limit order fulfillment bot

0. Start local devnet, refer to the [Complete Setup section in iCKB core](https://github.com/ickb/v1-core/#complete-setup) for further instructions:

```bash
(trap 'kill -INT 0' SIGINT; cd ~/ckb/; ckb run --indexer & sleep 5 && ckb miner)
```

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

4. Start simulation of user interactions:

```bash
npm run start
```

## Complete Setup

Please refer to the [Complete Setup section in iCKB core](https://github.com/ickb/v1-core/#complete-setup).

## Licensing

The license for this repository is the MIT License, see the [`LICENSE`](./LICENSE).
