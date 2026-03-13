import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import crypto from 'crypto';

const agent = new SocksProxyAgent('socks5h://100.104.177.44:1080');

// Get the page first
const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 60000
}, { timeout: 65000 });

const html = resp.data?.solution?.response || '';
const cookies = resp.data?.solution?.cookies || [];
const userAgent = resp.data?.solution?.userAgent || '';

const tokenMatch = html.match(/data-download-token="([^"]+)"/);
const apiPathMatch = html.match(/data-download-api-path="([^"]+)"/);
const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/);

const token = tokenMatch?.[1];
const apiPath = apiPathMatch?.[1];
const csrf = csrfMatch?.[1];
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

console.log('Token:', token);

// Call the download API
const postResp = await axios.post(`https://mkvdrama.net${apiPath}`,
    { t: token },
    {
        httpsAgent: agent,
        httpAgent: agent,
        headers: {
            'User-Agent': userAgent,
            'Cookie': cookieStr,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Referer': 'https://mkvdrama.net/yesterday-2026',
            'Origin': 'https://mkvdrama.net',
            'X-CSRF-Token': csrf
        },
        timeout: 15000,
        validateStatus: s => true
    }
);

console.log('API status:', postResp.status);
const encData = postResp.data;
console.log('Encrypted data length:', encData.d?.length);
console.log('Salt/IV:', encData.s);

// The data is encrypted. The decryption key is probably derived from the token or from the JS.
// Common patterns: AES-CBC or AES-GCM with key derived from token

// Let's try various decryption approaches
const d = Buffer.from(encData.d, 'base64');
const s = Buffer.from(encData.s, 'hex'); // looks like hex-encoded IV/salt

console.log('\nEncrypted data bytes:', d.length);
console.log('Salt/IV bytes:', s.length); // 12 bytes = could be GCM IV

// Token parts: series_id:base64_signature:timestamp:hex_hash
const tokenParts = token.split(':');
console.log('\nToken parts:');
console.log('  Series ID:', tokenParts[0]);
console.log('  Signature:', tokenParts[1]);
console.log('  Timestamp:', tokenParts[2]);
console.log('  Hash:', tokenParts[3]);

// Try different key derivations
const possibleKeys = [
    tokenParts[3], // hex hash
    tokenParts[1], // base64 signature
    token, // full token
    csrf, // CSRF token
    tokenParts[3] + tokenParts[2], // hash + timestamp
];

for (const keySource of possibleKeys) {
    // Try as raw hex key (AES-256 needs 32 bytes)
    try {
        const keyHex = keySource.padEnd(64, '0').substring(0, 64);
        const key = Buffer.from(keyHex, 'hex');

        // Try AES-256-GCM (12-byte IV is typical for GCM)
        try {
            const authTag = d.subarray(d.length - 16);
            const ciphertext = d.subarray(0, d.length - 16);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, s);
            decipher.setAuthTag(authTag);
            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            console.log(`\nDecrypted (GCM, key=${keySource.substring(0, 20)}...):`);
            console.log(decrypted.toString('utf8').substring(0, 2000));
            process.exit(0);
        } catch(e) {}

        // Try AES-256-CBC (16-byte IV, but s is 12 bytes)
        if (s.length >= 16) {
            try {
                const decipher = crypto.createDecipheriv('aes-256-cbc', key, s.subarray(0, 16));
                const decrypted = Buffer.concat([decipher.update(d), decipher.final()]);
                console.log(`\nDecrypted (CBC, key=${keySource.substring(0, 20)}...):`);
                console.log(decrypted.toString('utf8').substring(0, 2000));
                process.exit(0);
            } catch(e) {}
        }
    } catch(e) {}

    // Try SHA-256 of key source as the key
    try {
        const key = crypto.createHash('sha256').update(keySource).digest();

        // Try AES-256-GCM
        try {
            const authTag = d.subarray(d.length - 16);
            const ciphertext = d.subarray(0, d.length - 16);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, s);
            decipher.setAuthTag(authTag);
            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            console.log(`\nDecrypted (GCM+SHA256, key=${keySource.substring(0, 20)}...):`);
            console.log(decrypted.toString('utf8').substring(0, 2000));
            process.exit(0);
        } catch(e) {}
    } catch(e) {}

    // Try MD5 of key source as AES-128 key
    try {
        const key = crypto.createHash('md5').update(keySource).digest();

        // AES-128-GCM
        try {
            const authTag = d.subarray(d.length - 16);
            const ciphertext = d.subarray(0, d.length - 16);
            const decipher = crypto.createDecipheriv('aes-128-gcm', key, s);
            decipher.setAuthTag(authTag);
            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            console.log(`\nDecrypted (GCM-128+MD5, key=${keySource.substring(0, 20)}...):`);
            console.log(decrypted.toString('utf8').substring(0, 2000));
            process.exit(0);
        } catch(e) {}
    } catch(e) {}
}

console.log('\nCould not decrypt with any simple key derivation');
console.log('The decryption key is likely derived in the obfuscated site.bundle.js');
console.log('Raw encrypted data (base64):', encData.d.substring(0, 200));
