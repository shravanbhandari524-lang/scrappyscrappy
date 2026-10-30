import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_EXTENSIONS = new Set([
  'pdf', 'zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'exe', 'dmg',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'flv', 'mkv', 'webm',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'
]);

const SENSITIVE_KEYWORDS = ['logout', 'delete', 'checkout', 'payment'];

// Cache robots.txt parsers per origin
const robotsCache = new Map();

/**
 * Checks if an IP string (v4, v6, or v4-mapped) belongs to private/reserved ranges.
 */
export function isPrivateIp(ip) {
  if (!ip) return true;
  let cleanIp = ip.toLowerCase().trim().replace(/^\[|\]$/g, '');

  // Check IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1 or ::ffff:7f00:1)
  if (cleanIp.startsWith('::ffff:')) {
    const rest = cleanIp.slice(7);
    if (net.isIPv4(rest)) {
      cleanIp = rest;
    }
  }

  // IPv4 Checks
  if (net.isIPv4(cleanIp)) {
    const parts = cleanIp.split('.').map((p) => parseInt(p, 10));
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 (Private)
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (Link-local / Cloud metadata 169.254.169.254)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 100.64.0.0/10 (Shared address space / Alibaba metadata 100.100.100.200)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (Documentation)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
    if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
    if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
    // Broadcast
    if (cleanIp === '255.255.255.255') return true;
    return false;
  }

  // IPv6 Checks
  if (net.isIPv6(cleanIp)) {
    // :: and ::1
    if (cleanIp === '::' || cleanIp === '::1') return true;
    // Unique local address fc00::/7 (fc00:: - fdff::)
    if (/^[fF][cCdD]/.test(cleanIp)) return true;
    // Link-local unicast fe80::/10 (fe80:: - febf::)
    if (/^[fF][eE][89aAbB]/.test(cleanIp)) return true;
    // Discard prefix 100::/64
    if (cleanIp.startsWith('100::')) return true;
    return false;
  }

  return false;
}

/**
 * Checks synchronous string safety (protocol and obvious localhost/IPs).
 */
export function isBasicSafeUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { safe: false, reason: `Disallowed protocol: ${url.protocol}` };
    }
    const host = url.hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
      return { safe: false, reason: `Blocked hostname: ${host}` };
    }
    if (net.isIP(host) && isPrivateIp(host)) {
      return { safe: false, reason: `Blocked IP address: ${host}` };
    }
    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `Invalid URL: ${err.message}` };
  }
}

/**
 * Resolves DNS for the given URL and blocks private/reserved IPs.
 */
export async function isSafeUrlAsync(urlString) {
  const basic = isBasicSafeUrl(urlString);
  if (!basic.safe) return basic;

  try {
    const url = new URL(urlString);
    const host = url.hostname.replace(/^\[|\]$/g, '');

    // If host is already an IP
    if (net.isIP(host)) {
      if (isPrivateIp(host)) {
        return { safe: false, reason: `Blocked IP: ${host}` };
      }
      return { safe: true };
    }

    // Resolve DNS (IPv4 + IPv6)
    const records = await dns.lookup(host, { all: true });
    if (!records || records.length === 0) {
      return { safe: false, reason: `DNS lookup returned no addresses for ${host}` };
    }

    for (const record of records) {
      if (isPrivateIp(record.address)) {
        return {
          safe: false,
          reason: `DNS resolved ${host} to blocked IP ${record.address}`
        };
      }
    }

    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `DNS resolution failed: ${err.message}` };
  }
}

/**
 * Normalizes URL: resolves against base, strips hash, drops tracking params (utm_*, fbclid, gclid),
 * sorts query params alphabetically, and normalizes trailing slashes.
 */
export function normalizeUrl(rawUrl, baseUrl) {
  try {
    const trimmed = (rawUrl || '').trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('mailto:') ||
      lower.startsWith('tel:') ||
      lower.startsWith('javascript:') ||
      lower.startsWith('data:')
    ) {
      return null;
    }

    const parsed = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    parsed.hash = '';

    // Drop tracking parameters
    const searchParams = parsed.searchParams;
    const keysToDelete = [];
    for (const key of searchParams.keys()) {
      const k = key.toLowerCase();
      if (
        k.startsWith('utm_') ||
        k === 'fbclid' ||
        k === 'gclid' ||
        k === '_ga' ||
        k === '_gl'
      ) {
        keysToDelete.push(key);
      }
    }
    for (const k of keysToDelete) {
      searchParams.delete(k);
    }

    // Sort query parameters
    searchParams.sort();

    // Normalize trailing slash for non-root paths
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Checks whether two URLs belong to the same hostname / domain.
 */
export function isSameDomain(targetUrl, baseDomainUrl) {
  try {
    const t = new URL(targetUrl);
    const b = new URL(baseDomainUrl);
    return t.hostname.toLowerCase() === b.hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * URL skipping based on sensitive keywords or static file extensions.
 */
export function shouldSkipUrl(urlString) {
  try {
    const url = new URL(urlString);
    const fullLower = url.href.toLowerCase();

    for (const kw of SENSITIVE_KEYWORDS) {
      if (fullLower.includes(kw)) {
        return true;
      }
    }

    const pathname = url.pathname.toLowerCase();
    const lastSlash = pathname.lastIndexOf('/');
    const lastPart = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
    const dotIndex = lastPart.lastIndexOf('.');
    if (dotIndex > 0) {
      const ext = lastPart.slice(dotIndex + 1);
      if (BLOCKED_EXTENSIONS.has(ext)) {
        return true;
      }
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Computes crawl-trap path pattern:
 * - Replaces digit sequences in path segments with {n}
 * - Ignores query values (formats query keys as key={v})
 * - Checks length limit (2000 chars) and path segment limit (10 segments)
 */
export function getPathPattern(urlString) {
  try {
    if (typeof urlString !== 'string' || urlString.length > 2000) {
      return { valid: false, reason: 'URL exceeds 2000 characters' };
    }

    const url = new URL(urlString);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length > 10) {
      return { valid: false, reason: 'Path has more than 10 segments' };
    }

    const patternSegments = segments.map((seg) => seg.replace(/\d+/g, '{n}'));
    const patternPath = '/' + patternSegments.join('/');

    // Query values ignored, query keys sorted
    const queryKeys = Array.from(url.searchParams.keys()).sort();
    const queryPattern = queryKeys.length > 0 ? '?' + queryKeys.map((k) => `${k}={v}`).join('&') : '';

    return {
      valid: true,
      pattern: `${url.hostname}${patternPath}${queryPattern}`
    };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

/**
 * Checks if a URL exceeds the 50-page crawl-trap pattern cap.
 */
export function isCrawlTrap(urlString, patternCounts, cap = 50) {
  const check = getPathPattern(urlString);
  if (!check.valid) {
    return { trap: true, reason: check.reason };
  }

  const currentCount = patternCounts.get(check.pattern) || 0;
  if (currentCount >= cap) {
    return { trap: true, pattern: check.pattern, reason: `Pattern "${check.pattern}" reached limit of ${cap} pages` };
  }

  return { trap: false, pattern: check.pattern };
}

/**
 * Fetches and parses robots.txt for an origin, returning allowed/disallowed status.
 */
export async function isAllowedByRobotsTxt(urlString) {
  try {
    const url = new URL(urlString);
    const origin = url.origin;

    if (!robotsCache.has(origin)) {
      await loadRobotsTxt(origin);
    }

    const rules = robotsCache.get(origin);
    if (!rules) return true;

    const pathToCheck = url.pathname + (url.search || '');
    return isPathAllowed(rules, pathToCheck);
  } catch {
    return true;
  }
}

/**
 * Returns sitemap URLs found in robots.txt for an origin.
 */
export async function getRobotsSitemaps(origin) {
  if (!robotsCache.has(origin)) {
    await loadRobotsTxt(origin);
  }
  const rules = robotsCache.get(origin);
  return rules?.sitemaps || [];
}

async function loadRobotsTxt(origin) {
  const robotsUrl = `${origin}/robots.txt`;
  const safety = await isSafeUrlAsync(robotsUrl);
  if (!safety.safe) {
    robotsCache.set(origin, null);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'deepcrawl/1.0' }
    });
    clearTimeout(timeout);
    if (res.ok) {
      const text = await res.text();
      robotsCache.set(origin, parseRobotsTxt(text));
    } else {
      robotsCache.set(origin, null);
    }
  } catch {
    clearTimeout(timeout);
    robotsCache.set(origin, null);
  }
}

/**
 * Minimal robots.txt parser for User-agent rules and Sitemap directives.
 */
function parseRobotsTxt(content) {
  const lines = content.split('\n');
  const disallow = [];
  const allow = [];
  const sitemaps = [];
  let applies = false;

  for (let rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const [directive, ...valParts] = line.split(':');
    const key = (directive || '').trim().toLowerCase();
    const val = valParts.join(':').trim();

    if (key === 'user-agent') {
      const ua = val.toLowerCase();
      applies = ua === '*' || ua === 'deepcrawl';
    } else if (key === 'sitemap' && val) {
      sitemaps.push(val);
    } else if (applies) {
      if (key === 'disallow' && val) {
        disallow.push(val);
      } else if (key === 'allow' && val) {
        allow.push(val);
      }
    }
  }

  return { disallow, allow, sitemaps };
}

function isPathAllowed(rules, pathToCheck) {
  for (const a of rules.allow) {
    if (pathToCheck.startsWith(a)) {
      return true;
    }
  }
  for (const d of rules.disallow) {
    if (d === '/' || pathToCheck.startsWith(d)) {
      return false;
    }
  }
  return true;
}

/**
 * Discovers and parses URLs from sitemap.xml and robots.txt Sitemaps (capped at maxUrls).
 */
export async function discoverSitemapUrls(startUrl, maxUrls = 500) {
  const discovered = new Set();
  try {
    const origin = new URL(startUrl).origin;
    const robotsSitemaps = await getRobotsSitemaps(origin);
    const sitemapsToFetch = new Set([...robotsSitemaps, `${origin}/sitemap.xml`]);

    for (const sitemapUrl of sitemapsToFetch) {
      if (discovered.size >= maxUrls) break;

      const norm = normalizeUrl(sitemapUrl);
      if (!norm) continue;

      const safe = await isSafeUrlAsync(norm);
      if (!safe.safe) continue;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(norm, {
          signal: controller.signal,
          headers: { 'User-Agent': 'deepcrawl/1.0' }
        });
        clearTimeout(timeout);
        if (!res.ok) continue;

        const xmlText = await res.text();
        // Match <loc>...</loc>
        const matches = xmlText.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
        for (const match of matches) {
          if (discovered.size >= maxUrls) break;
          const locUrl = normalizeUrl(match[1]);
          if (!locUrl) continue;
          if (!isSameDomain(locUrl, startUrl)) continue;
          if (shouldSkipUrl(locUrl)) continue;

          // If nested sitemap XML, add to queue if room
          if (locUrl.endsWith('.xml') && !sitemapsToFetch.has(locUrl)) {
            sitemapsToFetch.add(locUrl);
            continue;
          }

          discovered.add(locUrl);
        }
      } catch {
        // Ignore single sitemap fetch failure
      }
    }
  } catch {
    // Ignore sitemap discovery errors
  }

  return Array.from(discovered);
}

export function sanitizeFilename(urlStr, index) {
  try {
    const u = new URL(urlStr);
    const raw = `${u.hostname}${u.pathname}${u.search}`;
    const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 60);
    const idx = String(index).padStart(3, '0');
    return `${idx}_${clean || 'page'}.png`;
  } catch {
    const idx = String(index).padStart(3, '0');
    return `${idx}_page.png`;
  }
}
