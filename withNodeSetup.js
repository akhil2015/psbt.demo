const { exec, spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Configuration
const LND_DIR = path.join(process.cwd(), '.lnd-data');
const DOCKER_CONTAINER = 'lnd-testnet-node';
const LND_REST_PORT = 8080;
const LND_RPC_PORT = 10009;
const LND_P2P_PORT = 9735;

// Helper: Sleep function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Setup LND Docker container
async function setupLNDDocker() {
  console.log('\n🚀 Setting up LND Docker container...\n');

  // Create data directory
  if (!fs.existsSync(LND_DIR)) {
    fs.mkdirSync(LND_DIR, { recursive: true });
    console.log('✓ Created LND data directory:', LND_DIR);
  }

  // Check if container already exists
  try {
    const { stdout } = await execAsync(`docker ps -a --filter name=${DOCKER_CONTAINER} --format "{{.Names}}"`);
    if (stdout.trim() === DOCKER_CONTAINER) {
      console.log('✓ Container already exists, removing old container...');
      await execAsync(`docker rm -f ${DOCKER_CONTAINER}`);
    }
  } catch (error) {
    // Container doesn't exist, continue
  }

  // Run LND container
  console.log('✓ Starting LND container on testnet...');
  
  const dockerCmd = `docker run -d \
    --name=${DOCKER_CONTAINER} \
    -v ${LND_DIR}:/root/.lnd \
    -p ${LND_REST_PORT}:8080 \
    -p ${LND_RPC_PORT}:10009 \
    -p ${LND_P2P_PORT}:9735 \
    lightninglabs/lnd:latest \
    --bitcoin.active \
    --bitcoin.testnet \
    --bitcoin.node=neutrino \
    --neutrino.connect=faucet.lightning.community \
    --neutrino.connect=testnet1-btcd.zaphq.io \
    --debuglevel=info \
    --restlisten=0.0.0.0:8080 \
    --rpclisten=0.0.0.0:10009 \
    --tlsextradomain=localhost \
    --no-macaroons=false`;

  await execAsync(dockerCmd.replace(/\s+/g, ' '));
  
  console.log('✓ LND container started successfully!');
  console.log('⏳ Waiting for LND to initialize (30 seconds)...');
  await sleep(30000);

  // Create wallet
  console.log('\n📝 Creating LND wallet...');
  try {
    const createWallet = spawn('docker', [
      'exec', '-i', DOCKER_CONTAINER,
      'lncli', '--network=testnet',
      'create'
    ]);

    // Auto-respond to wallet creation prompts
    createWallet.stdin.write('password123\n'); // Password
    createWallet.stdin.write('password123\n'); // Confirm password
    createWallet.stdin.write('n\n'); // Existing seed? No
    createWallet.stdin.write('\n'); // Passphrase (empty)
    createWallet.stdin.end();

    await new Promise((resolve) => {
      createWallet.on('close', () => {
        console.log('✓ Wallet created successfully!');
        resolve();
      });
    });
  } catch (error) {
    console.log('Note: Wallet may already exist');
  }

  console.log('⏳ Waiting for wallet to unlock (10 seconds)...');
  await sleep(10000);

  // Copy TLS cert and macaroon from container
  console.log('\n📋 Copying authentication files...');
  
  await execAsync(`docker cp ${DOCKER_CONTAINER}:/root/.lnd/tls.cert ${LND_DIR}/tls.cert`);
  await execAsync(`docker cp ${DOCKER_CONTAINER}:/root/.lnd/data/chain/bitcoin/testnet/admin.macaroon ${LND_DIR}/admin.macaroon`);
  
  console.log('✓ Authentication files copied');
  console.log('\n✅ LND setup complete!\n');
}

// LND REST API Client
class LNDClient {
  constructor() {
    this.tlsCertPath = path.join(LND_DIR, 'tls.cert');
    this.macaroonPath = path.join(LND_DIR, 'admin.macaroon');
    this.host = 'localhost';
    this.port = LND_REST_PORT;
  }

  async request(method, endpoint, body = null) {
    const tlsCert = fs.readFileSync(this.tlsCertPath);
    const macaroon = fs.readFileSync(this.macaroonPath).toString('hex');

    const httpsAgent = new https.Agent({
      ca: tlsCert,
      rejectUnauthorized: false
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
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
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Parse error: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async getInfo() {
    return this.request('GET', '/v1/getinfo');
  }

  async getBalance() {
    return this.request('GET', '/v1/balance/channels');
  }

  async createInvoice(amountSats, memo, expiry = 3600) {
    return this.request('POST', '/v1/invoices', {
      value: amountSats.toString(),
      memo: memo,
      expiry: expiry.toString()
    });
  }

  async payInvoice(paymentRequest) {
    return this.request('POST', '/v1/channels/transactions', {
      payment_request: paymentRequest
    });
  }

  async decodePayReq(paymentRequest) {
    return this.request('GET', `/v1/payreq/${paymentRequest}`);
  }

  async lookupInvoice(rHash) {
    return this.request('GET', `/v1/invoice/${rHash}`);
  }
}

// Main execution
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Lightning Network (LND) Node Setup & Test   ║');
  console.log('╚══════════════════════════════════════════════╝');

  try {
    // Check Docker availability
    try {
      await execAsync('docker --version');
    } catch (error) {
      console.error('❌ Docker is not installed. Please install Docker first.');
      console.error('Visit: https://docs.docker.com/get-docker/');
      process.exit(1);
    }

    // Setup LND
    await setupLNDDocker();

    // Initialize client
    const lnd = new LNDClient();

    // Test connection and operations
    console.log('\n═══════════════════════════════════════════════\n');
    console.log('🔍 Testing LND Connection & Operations\n');
    console.log('═══════════════════════════════════════════════\n');

    // Get node info
    console.log('1️⃣  Getting Node Information...');
    const info = await lnd.getInfo();
    console.log('   ✓ Node Alias:', info.alias || 'N/A');
    console.log('   ✓ Identity:', info.identity_pubkey?.substring(0, 20) + '...');
    console.log('   ✓ Network:', info.chains?.[0]?.network || 'testnet');
    console.log('   ✓ Synced:', info.synced_to_chain);
    console.log('   ✓ Block Height:', info.block_height);
    console.log('   ✓ Active Channels:', info.num_active_channels);

    // Get balance
    console.log('\n2️⃣  Getting Wallet Balance...');
    const balance = await lnd.getBalance();
    console.log('   ✓ Local Balance:', balance.local_balance?.sat || '0', 'sats');
    console.log('   ✓ Remote Balance:', balance.remote_balance?.sat || '0', 'sats');

    // Create invoice
    console.log('\n3️⃣  Creating Lightning Invoice...');
    const invoice = await lnd.createInvoice(1000, 'Test invoice from Node.js', 3600);
    console.log('   ✓ Payment Request:', invoice.payment_request.substring(0, 50) + '...');
    console.log('   ✓ Amount:', '1000 sats');
    console.log('   ✓ Memo:', 'Test invoice from Node.js');

    // Decode payment request
    console.log('\n4️⃣  Decoding Payment Request...');
    const decoded = await lnd.decodePayReq(invoice.payment_request);
    console.log('   ✓ Destination:', decoded.destination?.substring(0, 20) + '...');
    console.log('   ✓ Payment Hash:', decoded.payment_hash?.substring(0, 20) + '...');
    console.log('   ✓ Description:', decoded.description);
    console.log('   ✓ Amount:', decoded.num_satoshis, 'sats');

    // Lookup invoice
    console.log('\n5️⃣  Looking up Invoice Status...');
    const invoiceStatus = await lnd.lookupInvoice(invoice.r_hash);
    console.log('   ✓ State:', invoiceStatus.state);
    console.log('   ✓ Settled:', invoiceStatus.settled);

    console.log('\n═══════════════════════════════════════════════');
    console.log('\n✅ All operations completed successfully!\n');

    console.log('📌 Useful Information:');
    console.log('   • Data Directory:', LND_DIR);
    console.log('   • REST API:', `https://localhost:${LND_REST_PORT}`);
    console.log('   • RPC Port:', LND_RPC_PORT);
    console.log('   • Network:', 'Bitcoin Testnet');
    console.log('\n📝 To interact with your node:');
    console.log(`   docker exec -it ${DOCKER_CONTAINER} lncli --network=testnet getinfo`);
    console.log('\n🛑 To stop the node:');
    console.log(`   docker stop ${DOCKER_CONTAINER}`);
    console.log('\n🗑️  To remove everything:');
    console.log(`   docker rm -f ${DOCKER_CONTAINER} && rm -rf ${LND_DIR}`);
    console.log('\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\n💡 Make sure Docker is running and try again.');
    process.exit(1);
  }
}

// Run the script
main();
