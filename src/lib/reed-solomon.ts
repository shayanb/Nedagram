/**
 * Reed-Solomon Error Correction
 *
 * Pure JavaScript implementation using GF(2^8) with primitive polynomial 0x11D
 * Standard RS implementation suitable for RS(255, k)
 */

// Galois Field GF(2^8) with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

// Initialize Galois Field tables
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11D;
    }
  }
  // Duplicate for easier modular arithmetic
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

// Galois Field multiplication
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

// Galois Field division
function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

// Galois Field power
function gfPow(x: number, power: number): number {
  if (x === 0) return 0;
  return GF_EXP[(GF_LOG[x] * power) % 255];
}

// Galois Field inverse
function gfInverse(x: number): number {
  if (x === 0) throw new Error('Zero has no inverse');
  return GF_EXP[255 - GF_LOG[x]];
}

// Polynomial evaluation at x
function polyEval(poly: number[], x: number): number {
  let result = 0;
  for (let i = 0; i < poly.length; i++) {
    result = gfMul(result, x) ^ poly[i];
  }
  return result;
}

// Generate RS generator polynomial for n parity symbols
function generateGeneratorPoly(nsym: number): number[] {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const root = GF_EXP[i];
    const newG = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      newG[j] ^= g[j];
      newG[j + 1] ^= gfMul(g[j], root);
    }
    g = newG;
  }
  return g;
}

// Cache generator polynomials
const generatorCache = new Map<number, number[]>();

function getGenerator(nsym: number): number[] {
  if (!generatorCache.has(nsym)) {
    generatorCache.set(nsym, generateGeneratorPoly(nsym));
  }
  return generatorCache.get(nsym)!;
}

/**
 * RS Encoder
 */
export class RSEncoder {
  private generator: number[];
  private nsym: number;

  constructor(nsym: number) {
    this.nsym = nsym;
    this.generator = getGenerator(nsym);
  }

  /**
   * Encode data and append parity bytes
   */
  encode(data: Uint8Array): Uint8Array {
    const result = new Uint8Array(data.length + this.nsym);
    result.set(data, 0);

    // Polynomial long division
    for (let i = 0; i < data.length; i++) {
      const coef = result[i];
      if (coef !== 0) {
        for (let j = 1; j < this.generator.length; j++) {
          result[i + j] ^= gfMul(this.generator[j], coef);
        }
      }
    }

    // Restore original data (it was modified during division)
    result.set(data, 0);

    return result;
  }
}

/**
 * RS Decoder with corrected Berlekamp-Massey algorithm
 */
export class RSDecoder {
  private nsym: number;

  constructor(nsym: number) {
    this.nsym = nsym;
  }

  /**
   * Decode and correct errors in received data
   */
  decode(received: Uint8Array): { data: Uint8Array; correctedErrors: number } {
    const msg = Array.from(received);
    const n = msg.length;

    // Calculate syndromes
    const syndromes = this.calcSyndromes(msg);

    // Check if all syndromes are zero (no errors)
    if (syndromes.every(s => s === 0)) {
      return {
        data: new Uint8Array(msg.slice(0, n - this.nsym)),
        correctedErrors: 0,
      };
    }

    // Find error locator polynomial using Berlekamp-Massey
    const sigma = this.berlekampMassey(syndromes);

    // Check if too many errors
    const numErrors = sigma.length - 1;
    if (numErrors > this.nsym / 2) {
      throw new Error('RS decode failed: too many errors');
    }

    // Find error positions using Chien search
    const errPos = this.chienSearch(sigma, n);

    if (errPos.length !== numErrors) {
      throw new Error('RS decode failed: could not locate all errors');
    }

    // Calculate error evaluator polynomial: omega = syndrome * sigma mod x^nsym
    const omega = this.calcOmega(syndromes, sigma);

    // Find error magnitudes using Forney algorithm
    this.forney(msg, errPos, sigma, omega);

    // Verify correction by recalculating syndromes
    const newSyndromes = this.calcSyndromes(msg);
    if (!newSyndromes.every(s => s === 0)) {
      throw new Error('RS decode failed: correction verification failed');
    }

    return {
      data: new Uint8Array(msg.slice(0, n - this.nsym)),
      correctedErrors: errPos.length,
    };
  }

  private calcSyndromes(msg: number[]): number[] {
    const syndromes: number[] = [];
    for (let i = 0; i < this.nsym; i++) {
      syndromes.push(polyEval(msg, GF_EXP[i]));
    }
    return syndromes;
  }

  /**
   * Berlekamp-Massey algorithm - corrected implementation
   */
  private berlekampMassey(syndromes: number[]): number[] {
    const n = syndromes.length;

    // C(x) = current error locator polynomial
    // B(x) = previous error locator polynomial
    let C = [1];
    let B = [1];
    let L = 0; // Current number of assumed errors
    let m = 1; // Number of iterations since L was last updated
    let b = 1; // Previous discrepancy

    for (let i = 0; i < n; i++) {
      // Calculate discrepancy d
      let d = syndromes[i];
      for (let j = 1; j <= L; j++) {
        if (j < C.length) {
          d ^= gfMul(C[j], syndromes[i - j]);
        }
      }

      if (d === 0) {
        // No change needed
        m++;
      } else if (2 * L <= i) {
        // Update: L needs to grow
        const T = C.slice();
        const coef = gfDiv(d, b);

        // C(x) = C(x) - d/b * x^m * B(x)
        const scaledB = B.map(v => gfMul(v, coef));
        const shiftedB = new Array(m).fill(0).concat(scaledB);

        // Ensure C is long enough
        while (C.length < shiftedB.length) C.push(0);
        for (let j = 0; j < shiftedB.length; j++) {
          C[j] ^= shiftedB[j];
        }

        L = i + 1 - L;
        B = T;
        b = d;
        m = 1;
      } else {
        // Update C but don't change L
        const coef = gfDiv(d, b);
        const scaledB = B.map(v => gfMul(v, coef));
        const shiftedB = new Array(m).fill(0).concat(scaledB);

        while (C.length < shiftedB.length) C.push(0);
        for (let j = 0; j < shiftedB.length; j++) {
          C[j] ^= shiftedB[j];
        }
        m++;
      }
    }

    // Remove trailing zeros
    while (C.length > 1 && C[C.length - 1] === 0) {
      C.pop();
    }

    return C;
  }

  /**
   * Calculate error evaluator polynomial: omega = S * sigma mod x^nsym
   * Where S(x) = S_0 + S_1*x + S_2*x^2 + ...
   */
  private calcOmega(syndromes: number[], sigma: number[]): number[] {
    const omega = new Array(this.nsym).fill(0);
    for (let i = 0; i < this.nsym; i++) {
      for (let j = 0; j < sigma.length && i + j < this.nsym; j++) {
        omega[i + j] ^= gfMul(syndromes[i], sigma[j]);
      }
    }
    return omega;
  }

  /**
   * Chien search to find error positions (returns array indices)
   *
   * With polyEval convention: msg[i] corresponds to x^(n-1-i)
   * Error at array index i means polynomial power = n-1-i, so X = alpha^(n-1-i)
   * sigma has roots at X^-1, so sigma(alpha^(-(n-1-i))) = sigma(alpha^(i-n+1)) = 0
   *
   * If sigma(alpha^j) = 0, then j = i-n+1 (mod 255), so i = j+n-1 (mod 255)
   */
  private chienSearch(sigma: number[], n: number): number[] {
    const errPos: number[] = [];

    for (let j = 0; j < 255; j++) {
      // Evaluate sigma at alpha^j
      let sum = sigma[0];
      for (let k = 1; k < sigma.length; k++) {
        sum ^= gfMul(sigma[k], GF_EXP[(j * k) % 255]);
      }
      if (sum === 0) {
        // Convert to array index: i = j + n - 1 (mod 255)
        // But we need i to be in valid range [0, n-1]
        const arrayIdx = (j + n - 1) % 255;
        if (arrayIdx < n) {
          errPos.push(arrayIdx);
        }
      }
    }

    return errPos;
  }

  /**
   * Forney algorithm to find error magnitudes
   * e_j = X_j * Omega(X_j^-1) / Sigma'(X_j^-1)
   * Where X_j = alpha^(n-1-arrayIdx) (the error locator for array index arrayIdx)
   */
  private forney(
    msg: number[],
    errPos: number[],
    sigma: number[],
    omega: number[]
  ): void {
    const n = msg.length;

    // Calculate formal derivative of sigma: sigma'(x)
    // In GF(2^m), derivative of x^k is k*x^(k-1), and k mod 2 determines if term survives
    const sigmaPrime = new Array(Math.max(0, sigma.length - 1)).fill(0);
    for (let i = 1; i < sigma.length; i++) {
      if (i % 2 === 1) {
        sigmaPrime[i - 1] = sigma[i];
      }
    }

    for (const arrayIdx of errPos) {
      // X_j = alpha^(n-1-arrayIdx) is the error locator
      const power = n - 1 - arrayIdx;
      const Xj = GF_EXP[power % 255];
      const XjInv = GF_EXP[(255 - power % 255) % 255];

      // Evaluate omega at XjInv
      let omegaVal = 0;
      for (let i = 0; i < omega.length; i++) {
        omegaVal ^= gfMul(omega[i], gfPow(XjInv, i));
      }

      // Evaluate sigma' at XjInv
      let sigmaPrimeVal = 0;
      for (let i = 0; i < sigmaPrime.length; i++) {
        sigmaPrimeVal ^= gfMul(sigmaPrime[i], gfPow(XjInv, i));
      }

      if (sigmaPrimeVal === 0) {
        continue;
      }

      // Error magnitude = Xj * omega(XjInv) / sigma'(XjInv)
      const magnitude = gfMul(Xj, gfDiv(omegaVal, sigmaPrimeVal));
      msg[arrayIdx] ^= magnitude;
    }
  }
}

// Create default encoder/decoder for our frame size (32 parity bytes)
export const rsEncoder = new RSEncoder(32);
export const rsDecoder = new RSDecoder(32);
