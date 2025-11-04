const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
  // LND REST API endpoint
  host: 'localhost',
  port: 8080,
  
  // Authentication files (update these paths)
  tlsCertPath: path.join(process.env.HOME || process.env.USERPROFILE, '.lnd/tls.cert'),
  macaroonPath: path.join(process.env.HOME || process.env.USERPROFILE, '.lnd/data/chain/bitcoin/testnet/admin.macaroon'),
  
  // Network: 'testnet' or 'mainnet'
  network: 'testnet'
};

// Load TLS certificate and macaroon
let tlsCert, macaroon;
try {
  tlsCert = fs.readFileSync(config.tlsCertPath);
  macaroon = fs.readFileSync(config.macaroonPath).toString('hex');
} catch (error) {
  console.error('Error loading authentication files:', error.message);
  console.error('Make sure LND is running and paths are correct');
  process.exit(1);
}

// HTTPS agent with TLS certificate
const httpsAgent = new https.Agent({
  ca: tlsCert,
  rejectUnauthorized: false
});

// Make authenticated request to LND REST API
function lndRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: config.host,
      port: config.port,
      path: endpoint,
      method: method,
      agent: httpsAgent,
      headers: {
        'Grpc-Metadata-macaroon': macaroon,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

// Get node info
async function getNodeInfo() {
  console.log('\n=== Getting Node Information ===');
  try {
    const info = await lndRequest('GET', '/v1/getinfo');
    console.log('Node Alias:', info.alias);
    console.log('Node Pubkey:', info.identity_pubkey);
    console.log('Network:', info.chains?.[0]?.network || 'unknown');
    console.log('Synced to Chain:', info.synced_to_chain);
    console.log('Block Height:', info.block_height);
    console.log('Active Channels:', info.num_active_channels);
    console.log('Peers:', info.num_peers);
    return info;
  } catch (error) {
    console.error('Error getting node info:', error.message);
    throw error;
  }
}

// Create Lightning invoice
async function createInvoice(amountSats, memo, expirySeconds = 3600) {
  console.log('\n=== Creating Lightning Invoice ===');
  try {
    const invoiceData = {
      value: amountSats.toString(),
      memo: memo,
      expiry: expirySeconds.toString()
    };

    const invoice = await lndRequest('POST', '/v1/invoices', invoiceData);
    
    console.log('Invoice Created Successfully!');
    console.log('Payment Request (BOLT11):', invoice.payment_request);
    console.log('Payment Hash:', invoice.r_hash);
    console.log('Amount (sats):', amountSats);
    console.log('Memo:', memo);
    console.log('Expiry:', expirySeconds, 'seconds');
    
    return invoice;
  } catch (error) {
    console.error('Error creating invoice:', error.message);
    throw error;
  }
}

// Pay a Lightning invoice
async function payInvoice(paymentRequest) {
  console.log('\n=== Paying Lightning Invoice ===');
  try {
    const paymentData = {
      payment_request: paymentRequest
    };

    const payment = await lndRequest('POST', '/v1/channels/transactions', paymentData);
    
    if (payment.payment_error) {
      console.error('Payment Error:', payment.payment_error);
      return payment;
    }

    console.log('Payment Successful!');
    console.log('Payment Hash:', payment.payment_hash);
    console.log('Payment Preimage:', payment.payment_preimage);
    console.log('Route:', JSON.stringify(payment.payment_route, null, 2));
    
    return payment;
  } catch (error) {
    console.error('Error paying invoice:', error.message);
    throw error;
  }
}

// Lookup invoice by payment hash
async function lookupInvoice(rHashBase64) {
  console.log('\n=== Looking Up Invoice ===');
  try {
    const invoice = await lndRequest('GET', `/v1/invoice/${rHashBase64}`);
    
    console.log('Invoice State:', invoice.state);
    console.log('Value (sats):', invoice.value);
    console.log('Settled:', invoice.settled);
    console.log('Creation Date:', new Date(invoice.creation_date * 1000).toISOString());
    
    if (invoice.settled) {
      console.log('Settle Date:', new Date(invoice.settle_date * 1000).toISOString());
    }
    
    return invoice;
  } catch (error) {
    console.error('Error looking up invoice:', error.message);
    throw error;
  }
}

// Decode payment request
async function decodePayReq(paymentRequest) {
  console.log('\n=== Decoding Payment Request ===');
  try {
    const decoded = await lndRequest('GET', `/v1/payreq/${paymentRequest}`);
    
    console.log('Destination:', decoded.destination);
    console.log('Payment Hash:', decoded.payment_hash);
    console.log('Amount (sats):', decoded.num_satoshis);
    console.log('Description:', decoded.description);
    console.log('Expiry:', decoded.expiry, 'seconds');
    console.log('Timestamp:', new Date(decoded.timestamp * 1000).toISOString());
    
    return decoded;
  } catch (error) {
    console.error('Error decoding payment request:', error.message);
    throw error;
  }
}

// Get wallet balance
async function getBalance() {
  console.log('\n=== Getting Wallet Balance ===');
  try {
    const balance = await lndRequest('GET', '/v1/balance/channels');
    
    console.log('Local Balance (sats):', balance.local_balance?.sat || 0);
    console.log('Remote Balance (sats):', balance.remote_balance?.sat || 0);
    console.log('Pending Open Balance (sats):', balance.pending_open_local_balance?.sat || 0);
    
    return balance;
  } catch (error) {
    console.error('Error getting balance:', error.message);
    throw error;
  }
}

// Main execution
async function main() {
  try {
    // 1. Get node information
    await getNodeInfo();

    // 2. Get wallet balance
    await getBalance();

    // 3. Create an invoice
    const invoice = await createInvoice(1000, 'Test invoice from Node.js script', 3600);

    // 4. Lookup the created invoice
    await lookupInvoice(invoice.r_hash);

    // 5. Decode a payment request
    await decodePayReq(invoice.payment_request);

    // 6. Pay an invoice (uncomment to use - requires a valid payment request)
    // const paymentRequest = 'lntb...'; // Replace with actual payment request
    // await payInvoice(paymentRequest);

    console.log('\n✅ All operations completed successfully!');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the script
main();
