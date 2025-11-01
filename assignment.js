const axios = require("axios");
const bitcoin = require("bitcoinjs-lib");
const ECPairFactory = require("ecpair").default;
const tinysecp = require("tiny-secp256k1");

// ============================================================================
// CONSTANTS
// ============================================================================
const ECPair = ECPairFactory(tinysecp);
const network = bitcoin.networks.testnet;

// Hardcoded wallet values (same wallet needs to be used again, fresh wallets have 0 balance)
const WALLET = {
  privateKey: "cTGAe5L4f2yUUFf1dfc4cbu8dWSmwDv2Yy6Hys4LvqMwmXqEAw9T",
  address: "tb1qt5j5snh3nt5d6udhekupyrp6rqdnpwmyedjy9s",
};

// Transaction parameters
const AMOUNT_TO_SEND = 1000; // satoshis
const DESTINATION_ADDRESS = "tb1qlj64u6fqutr0xue85kl55fx0gt4m4urun25p7q"; // Testnet faucet
const FEE = 200; // satoshis

// API endpoints
const MEMPOOL_API_BASE = "https://mempool.space/testnet/api";


/**
 * Fetch UTXOs for a given address from mempool.space API
 * @param {string} address - Bitcoin address to fetch UTXOs for
 * @returns {Promise<Array>} - Array of UTXO objects
 */
async function getUTXOs(address) {
  console.log(`\nFetching UTXOs for address: ${address}`);
  const url = `${MEMPOOL_API_BASE}/address/${address}/utxo`;
  
  try {
    const { data } = await axios.get(url);
    console.log(`  - Found ${data.length} UTXO(s)`);
    
    if (data.length === 0) {
      throw new Error("No UTXOs found for this address");
    }
    
    // Map to our expected format
    const utxos = data.map(utxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      status: utxo.status,
    }));
    
    return utxos;
  } catch (error) {
    throw new Error(`Failed to fetch UTXOs: ${error.message}`);
  }
}

/**
 * Get the full transaction hex for a given txid
 * @param {string} txid - Transaction ID
 * @returns {Promise<string>} - Transaction hex string
 */
async function getTransactionHex(txid) {
  console.log(`\nFetching transaction hex for: ${txid}`);
  const url = `${MEMPOOL_API_BASE}/tx/${txid}/hex`;
  
  try {
    const { data } = await axios.get(url);
    console.log(`  - Successfully fetched hex.`);
    return data;
  } catch (error) {
    throw new Error(
      `Failed to fetch transaction hex for UTXO: ${error.message}`
    );
  }
}

/**
 * Broadcast the raw transaction to the network
 * @param {string} txHex - Raw transaction hex string
 * @returns {Promise<string>} - Transaction ID (TXID)
 */
async function broadcastTransaction(txHex) {
  const url = `${MEMPOOL_API_BASE}/tx`;
  
  try {
    const { data } = await axios.post(url, txHex, {
      headers: { "Content-Type": "text/plain" },
    });
    return data;
  } catch (error) {
    throw new Error(`Failed to broadcast transaction: ${error.message}`);
  }
}


async function simulatePSBT() {
  console.log("Starting PSBT creation and broadcast simulation...");

  try {
    // Initialize key pair from private key
    const keyPair = ECPair.fromWIF(WALLET.privateKey, network);

    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network,
    });

    console.log(`\n Wallet Details:`);
    console.log(`  Address (p2wpkh): ${address}`);

    // STEP 1: FETCH UTXOs DYNAMICALLY
    const utxos = await getUTXOs(address);
    
    // Select the first UTXO with sufficient balance
    const utxo = utxos.find(u => u.value >= AMOUNT_TO_SEND + FEE);
    
    if (!utxo) {
      throw new Error(
        `No UTXO with sufficient balance found. Need at least ${AMOUNT_TO_SEND + FEE} satoshis.`
      );
    }

    console.log(`\nSelected UTXO:`);
    console.log(`  - TXID: ${utxo.txid}`);
    console.log(`  - VOUT: ${utxo.vout}`);
    console.log(`  - Value: ${utxo.value} satoshis`);

    // Fetch the full transaction hex for the UTXO
    const utxoTxHex = await getTransactionHex(utxo.txid);
    console.log("utxoTxHex",utxoTxHex)

    // STEP 2: PSBT CREATION - CONSTRUCT THE TRANSACTION
    console.log(`\nConstructing PSBT...`);

    const psbt = new bitcoin.Psbt({ network });

    // Add the input (the UTXO we are spending)
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network })
          .output,
        value: BigInt(utxo.value),
      },
  
    });
    console.log(`  - Input added: ${utxo.txid}:${utxo.vout}`);

    // Calculate change
    const change = utxo.value - AMOUNT_TO_SEND - FEE;

    if (change < 0) {
      throw new Error(
        "Input amount is not enough to cover the transaction and fee."
      );
    }

    // Add the outputs
    psbt.addOutput({
      address: DESTINATION_ADDRESS,
      value: BigInt(AMOUNT_TO_SEND),
    });
    console.log(
      `  - Output added: ${AMOUNT_TO_SEND} satoshis to ${DESTINATION_ADDRESS}`
    );

    if (change > 0) {
      psbt.addOutput({
        address: address, // Change goes back to our own address
        value: BigInt(change),
      });
      console.log(`  - Change output added: ${change} satoshis to ${address}`);
    }

    // STEP 3: SIGN AND FINALIZE THE PSBT
    console.log(`\nSigning transaction...`);

    // Sign the first (and only) input with our key pair
    psbt.signInput(0, keyPair);
    console.log(`  - Input 0 signed.`);

    // Finalize the transaction to make it ready for broadcast
    psbt.finalizeAllInputs();
    console.log(`  - All inputs finalized.`);

    // Extract the final raw transaction in hexadecimal format
    const txHex = psbt.extractTransaction().toHex();
    console.log(`\nFinal Raw Transaction Hex:`);
    console.log(txHex);

    // STEP 4: BROADCAST THE SIGNED TRANSACTION
    console.log(`\nBroadcasting transaction to the Bitcoin Testnet...`);
    const txid = await broadcastTransaction(txHex);
    console.log(`  - Transaction broadcast successful!`);

    // STEP 5: DISPLAY TRANSACTION ON A BITCOIN EXPLORER
    console.log(`\nTransaction Details:`);
    console.log(`  - Transaction ID (TXID): ${txid}`);
    console.log(
      `  - View on Block Explorer: https://mempool.space/testnet/tx/${txid}`
    );
  } catch (error) {
    console.error("\nAn error occurred during the simulation:",error);
    if (error.response) {
      console.error(`  - Status: ${error.response.status}`);
      console.error(`  - Data: ${error.response.data}`);
    } else {
      console.error(`  - Message: ${error.message}`);
    }
  }
}

simulatePSBT();
