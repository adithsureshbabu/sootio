import { obfuscateSensitive } from '../common/torrent-utils.js';

const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/g;

function maskValue(value) {
  if (value == null) return 'empty';
  const str = String(value);
  if (str.length <= 4) return '***';
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

/**
 * Sanitize API keys/tokens to avoid invalid header characters.
 * Removes control characters and trims leading/trailing whitespace.
 */
export function sanitizeToken(value, label = 'apiKey', logPrefix = 'CONFIG') {
  if (value == null) return value;

  const original = String(value);
  const trimmed = original.trim();
  const cleaned = trimmed.replace(CONTROL_CHARS_REGEX, '');

  if (cleaned !== original) {
    const maskedBefore = maskValue(original);
    const maskedAfter = maskValue(cleaned);
    const obfuscated = obfuscateSensitive(`${maskedBefore} -> ${maskedAfter}`, original);
    console.error(`[${logPrefix}] Sanitized ${label} to remove whitespace/control chars (${obfuscated})`);
  }

  return cleaned;
}

/**
 * Sanitize configuration object by cleaning API key-like fields.
 * Returns a shallow-cloned object when changes are applied.
 */
export function sanitizeConfig(rawConfig, logPrefix = 'CONFIG') {
  if (!rawConfig || typeof rawConfig !== 'object') return rawConfig;

  let changed = false;
  const config = { ...rawConfig };

  const sanitizeField = (value, label) => {
    const cleaned = sanitizeToken(value, label, logPrefix);
    if (cleaned !== value) changed = true;
    return cleaned;
  };

  if ('DebridApiKey' in config) {
    config.DebridApiKey = sanitizeField(config.DebridApiKey, 'DebridApiKey');
  }

  if ('DebridLinkApiKey' in config) {
    config.DebridLinkApiKey = sanitizeField(config.DebridLinkApiKey, 'DebridLinkApiKey');
  }

  if ('HomeMediaApiKey' in config) {
    config.HomeMediaApiKey = sanitizeField(config.HomeMediaApiKey, 'HomeMediaApiKey');
  }

  if ('NewznabApiKey' in config) {
    config.NewznabApiKey = sanitizeField(config.NewznabApiKey, 'NewznabApiKey');
  }

  if ('SabnzbdApiKey' in config) {
    config.SabnzbdApiKey = sanitizeField(config.SabnzbdApiKey, 'SabnzbdApiKey');
  }

  if ('fileServerPassword' in config) {
    config.fileServerPassword = sanitizeField(config.fileServerPassword, 'fileServerPassword');
  }

  if (Array.isArray(config.DebridServices)) {
    config.DebridServices = config.DebridServices.map((service, index) => {
      if (!service || typeof service !== 'object') return service;
      const next = { ...service };

      if ('apiKey' in next) {
        next.apiKey = sanitizeField(next.apiKey, `DebridServices[${index}].apiKey`);
      }

      if ('newznabApiKey' in next) {
        next.newznabApiKey = sanitizeField(next.newznabApiKey, `DebridServices[${index}].newznabApiKey`);
      }

      if ('sabnzbdApiKey' in next) {
        next.sabnzbdApiKey = sanitizeField(next.sabnzbdApiKey, `DebridServices[${index}].sabnzbdApiKey`);
      }

      if ('fileServerPassword' in next) {
        next.fileServerPassword = sanitizeField(next.fileServerPassword, `DebridServices[${index}].fileServerPassword`);
      }

      if ('homeMediaApiKey' in next) {
        next.homeMediaApiKey = sanitizeField(next.homeMediaApiKey, `DebridServices[${index}].homeMediaApiKey`);
      }

      return next;
    });
    changed = true;
  }

  return changed ? config : rawConfig;
}

export default sanitizeConfig;
