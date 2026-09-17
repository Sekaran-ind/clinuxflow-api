// Irreversible password hashing via Web Crypto's PBKDF2 (crypto.subtle.deriveBits) — not
// encryption (AES etc. is reversible, the wrong primitive for passwords). Self-describing format
// so the scheme/iteration count/salt travel with the hash: bumping ITERATIONS later doesn't
// break existing stored hashes, since each one carries its own original count.
//
//   pbkdf2-sha256$<iterations>$<saltBase64>$<hashBase64>
const ITERATIONS = 100_000;
const HASH_BITS = 256;

export async function hashPassword(plaintext) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hashBytes = await deriveBits(plaintext, salt, ITERATIONS);
    return `pbkdf2-sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(hashBytes)}`;
}

export async function verifyPassword(plaintext, storedHash) {
    const parts = String(storedHash).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;

    let salt, expectedHash;
    try {
        salt = fromBase64(parts[2]);
        expectedHash = fromBase64(parts[3]);
    } catch {
        return false;
    }

    const actualHash = await deriveBits(plaintext, salt, iterations);
    return timingSafeEqual(actualHash, expectedHash);
}

async function deriveBits(plaintext, salt, iterations) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(plaintext), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, keyMaterial, HASH_BITS
    );
    return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
