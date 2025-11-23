/**
 * Mapple API helpers
 * Handles creation of encrypted request payloads used by mapple.site
 */

const ENCRYPTION_KEY = 'nanananananananananananaBatman!';

/**
 * XORs a string with the encryption key and returns a base64url encoded string
 * @param {string} input
 * @param {string} key
 * @returns {string}
 */
function xorAndEncode(input, key) {
    let output = '';
    for (let i = 0; i < input.length; i++) {
        output += String.fromCharCode(
            input.charCodeAt(i) ^ key.charCodeAt(i % key.length)
        );
    }
    return Buffer.from(output, 'binary')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

/**
 * Generates the encrypted payload expected by the Mapple API
 * Mirrors the logic present in mapple.site's frontend bundle.
 * @param {Object} payload - request payload object
 * @param {Object} [options]
 * @param {number} [options.timestamp] - override timestamp for testing
 * @param {string} [options.nonce] - override nonce for testing
 * @returns {string}
 */
export function encodeMapplePayload(payload, options = {}) {
    const timestamp = options.timestamp ?? Date.now();
    const nonce =
        options.nonce ??
        (Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15));

    const wrapped = JSON.stringify({
        url: typeof payload === 'string' ? payload : JSON.stringify(payload),
        timestamp,
        nonce
    });

    return xorAndEncode(encodeURIComponent(wrapped), ENCRYPTION_KEY);
}

/**
 * Builds the encrypted URL for the requested endpoint
 * @param {string} endpoint - e.g. "stream-encrypted"
 * @param {Object} payload - payload object
 * @param {string} [sessionId] - optional session id required by Mapple
 * @param {Object} [options] - passthrough to encodeMapplePayload
 * @returns {string}
 */
export function buildEncryptedUrl(endpoint, payload, sessionId, options = {}) {
    const data = encodeMapplePayload(payload, options);
    const url = new URL(`https://mapple.site/api/${endpoint}`);
    url.searchParams.set('data', data);

    if (endpoint === 'stream-encrypted' && sessionId) {
        url.searchParams.set('sessionId', sessionId);
    }

    return url.toString();
}
