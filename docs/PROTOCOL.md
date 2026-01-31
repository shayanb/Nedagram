# Nedagram Protocol Specification

**Version**: 3.0 (N3)
**Last Updated**: January 2026

This document describes the wire format and encoding used by Nedagram to transmit text data over audio.

## Table of Contents

1. [Overview](#overview)
2. [Transmission Structure](#transmission-structure)
3. [Preamble](#preamble)
4. [Frame Format](#frame-format)
5. [Audio Parameters](#audio-parameters)
6. [Encryption](#encryption)
7. [Error Correction](#error-correction)
8. [Decoder State Machine](#decoder-state-machine)
9. [Timing Diagrams](#timing-diagrams)

---

## Overview

Nedagram encodes data into audio tones using MFSK (Multiple Frequency Shift Keying) modulation. The protocol supports two modes optimized for different audio channels:

| Mode | Use Case | Tones | Bits/Symbol | Effective Rate |
|------|----------|-------|-------------|----------------|
| **Phone** | GSM/VoIP calls | 4 | 2 | ~20 bps |
| **Wideband** | HD Voice/Direct | 16 | 4 | ~50 bps |

### Pipeline Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                        SENDER                                     │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│   Input Text ──► Compress ──► Encrypt* ──► Frame ──► FEC ──► MFSK │
│                  (DEFLATE)    (ChaCha20)   (N3)     (RS+Conv)     │
│                                                                   │
└───────────────────────────────┬───────────────────────────────────┘
                                │ Audio
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                        RECEIVER                                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│   MFSK ──► FEC Decode ──► Deframe ──► Decrypt* ──► Decompress     │
│   Detect   (Viterbi+RS)             (ChaCha20)    (DEFLATE)       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                                                    * if encrypted
```

---

## Transmission Structure

A complete transmission consists of four parts:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE TRANSMISSION                              │
├─────────────┬─────────────┬──────────────────────────┬─────────────────────┤
│  PREAMBLE   │   HEADER    │     DATA FRAMES          │    END MARKER       │
│             │   FRAME     │                          │                     │
│  ~1.8-2.2s  │   ~8-17s    │   Variable               │     ~0.4s           │
├─────────────┼─────────────┼──────────────────────────┼─────────────────────┤
│ • Warmup    │ • Magic N3  │ • Frame 1                │ • Sync pattern      │
│ • Chirp     │ • Flags     │ • Frame 2                │   (8 symbols)       │
│ • Calibrate │ • Lengths   │ • ...                    │                     │
│ • Sync      │ • CRC16     │ • Frame N                │                     │
└─────────────┴─────────────┴──────────────────────────┴─────────────────────┘
```

---

## Preamble

The preamble provides automatic gain control (AGC) settling, mode detection, and symbol synchronization.

### Preamble Sequence

```
        ┌────────────┬──────────────────────────┬───────────────┬────────────┐
        │  WARMUP    │         CHIRP            │  CALIBRATION  │    SYNC    │
        │   TONE     │    (Up + Down sweep)     │    TONES      │  PATTERN   │
        ├────────────┼──────────────────────────┼───────────────┼────────────┤
 Phone: │   200ms    │   400ms + 400ms          │   2×4 tones   │  8 symbols │
        │  ~1600Hz   │   600→2600→600 Hz        │   400ms       │   400ms    │
        ├────────────┼──────────────────────────┼───────────────┼────────────┤
  Wide: │   400ms    │   600ms + 600ms          │   3×4 tones   │  8 symbols │
        │  ~3000Hz   │   1000→4000→1000 Hz      │   480ms       │   320ms    │
        └────────────┴──────────────────────────┴───────────────┴────────────┘
```

### Chirp Signal (Mode Detection)

The chirp is a linear frequency sweep used for timing synchronization and mode detection:

```
Phone Mode Chirp (800ms total):

  Freq (Hz)
   2600 ─┐                    ╱╲
         │                   ╱  ╲
   1600 ─┤                 ╱    ╲
         │               ╱        ╲
    600 ─┴─────────────╱──────────╲──────────────
         0           400ms        800ms
                   ▲
                   └── Peak (chirp end detection point)

Wideband Mode Chirp (1200ms total):

  Freq (Hz)
   4000 ─┐                    ╱╲
         │                   ╱  ╲
   2500 ─┤                 ╱    ╲
         │               ╱        ╲
   1000 ─┴─────────────╱──────────╲──────────────
         0           600ms       1200ms
```

### Calibration Tones

Known tone sequence for amplitude/frequency calibration:

```
Phone Mode: Tones [0, 1, 2, 3] repeated 2×

  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
  │  0   │  1   │  2   │  3   │  0   │  1   │  2   │  3   │
  │800Hz │1300Hz│1800Hz│2300Hz│800Hz │1300Hz│1800Hz│2300Hz│
  └──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┘
  │◄─────── 50ms each symbol ───────►│

Wideband Mode: Tones [0, 5, 10, 15] repeated 3×

  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
  │  0   │  5   │  10  │  15  │  0   │  5   │  10  │  15  │  0   │  5   │  10  │  15  │
  │1800Hz│3100Hz│4400Hz│5700Hz│......│......│......│......│......│......│......│......│
  └──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┘
  │◄─────── 40ms each symbol ───────►│
```

### Sync Pattern

Fixed alternating pattern for frame alignment:

```
Phone:    [0, 3, 0, 3, 0, 3, 0, 3]  →  [800, 2300, 800, 2300, ...] Hz
Wideband: [0, 15, 0, 15, 0, 15, 0, 15]  →  [1800, 5700, 1800, 5700, ...] Hz
```

---

## Frame Format

### Header Frame (12 bytes)

```
 Byte:    0     1     2     3     4     5     6     7     8     9    10    11
       ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬──────┐
       │  N  │  3  │V|Flg│Frms │  Payload Len    │  Original Len   │ Session ID │
       │0x4E │0x33 │     │     │    (LE)         │    (LE)         │    (LE)    │
       └─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴──────┘
       │◄─ Magic ─►│     │     │◄─── 2 bytes  ──►│◄─── 2 bytes  ──►│◄─ 2 bytes─►│
                   │     │                                         │
                   │     └─ Total frame count (1-255)              └─ CRC16 of [0-9]
                   │
                   └─ Version (high nibble) + Flags (low nibble)

Flags (byte 2, low nibble):
  Bit 0 (0x01): COMPRESSED - Data is DEFLATE compressed
  Bit 1 (0x02): ENCRYPTED  - Data is ChaCha20 encrypted
```

**Field Details:**

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0-1 | 2 | Magic | `"N3"` (0x4E 0x33) - Protocol v3 identifier |
| 2 | 1 | Version+Flags | High nibble: version (0x30), Low nibble: flags |
| 3 | 1 | Frame Count | Total number of data frames (1-255) |
| 4-5 | 2 | Payload Length | Compressed/encrypted payload size (little-endian) |
| 6-7 | 2 | Original Length | Original uncompressed size (little-endian) |
| 8-9 | 2 | Session ID | Random identifier for this transmission |
| 10-11 | 2 | CRC16 | CRC16-CCITT of bytes 0-9 |

### Data Frame (3 + N bytes)

```
 Byte:    0     1     2     3 ... N+2
       ┌─────┬─────┬─────┬─────────────────────┐
       │  D  │Index│ Len │      Payload        │
       │0x44 │     │     │    (variable)       │
       └─────┴─────┴─────┴─────────────────────┘
       │Magic│     │     │◄─ Len bytes ───────►│
             │     │
             │     └─ Payload length in this frame
             │
             └─ Frame index (1-based)
```

**Field Details:**

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 1 | Magic | `"D"` (0x44) - Data frame identifier |
| 1 | 1 | Frame Index | 1-based frame number |
| 2 | 1 | Payload Length | Bytes of payload in this frame |
| 3+ | N | Payload | Actual data (no padding) |

### End Marker

8 sync pattern symbols signal end of transmission:
- Phone: `[0, 3, 0, 3, 0, 3, 0, 3]`
- Wideband: `[0, 15, 0, 15, 0, 15, 0, 15]`

---

## Audio Parameters

### Phone Mode (GSM Compatible)

Optimized for narrowband audio channels (300-3400 Hz):

```
Parameter           Value
─────────────────────────────────────
Modulation          4-MFSK (2 bits/symbol)
Sample Rate         48,000 Hz
Symbol Duration     50 ms
Guard Interval      12 ms (Hann fade)
Base Frequency      800 Hz
Tone Spacing        500 Hz
Frequency Range     800 - 2300 Hz

Tone Index    Frequency
    0           800 Hz
    1          1300 Hz
    2          1800 Hz
    3          2300 Hz
```

### Wideband Mode (HD Voice / Direct)

Optimized for wideband audio (up to 7 kHz):

```
Parameter           Value
─────────────────────────────────────
Modulation          16-MFSK (4 bits/symbol)
Sample Rate         48,000 Hz
Symbol Duration     40 ms
Guard Interval      5 ms (Hann fade)
Base Frequency      1800 Hz
Tone Spacing        260 Hz
Frequency Range     1800 - 5700 Hz

Tone Index    Frequency
    0          1800 Hz
    1          2060 Hz
    2          2320 Hz
    ...          ...
   14          5440 Hz
   15          5700 Hz
```

### Symbol Waveform

Each symbol is a sine wave with Hann window fade:

```
Amplitude
    │     ╭────────────────────────────────╮
  1 ┤    ╱                                  ╲
    │   ╱                                    ╲
    │  ╱                                      ╲
  0 ┴─╱────────────────────────────────────────╲──►
    │◄──►│◄────────────────────────────►│◄──►│
     Fade     Symbol Duration (tone)      Fade   Guard
      In                                   Out   Interval
```

---

## Encryption

When enabled, encryption adds 44 bytes of overhead and sets the ENCRYPTED flag.

### Encryption Overhead

```
┌──────────────────────────────────────────────────────────┐
│                  ENCRYPTED PAYLOAD                       │
├────────────┬────────────┬────────────────────┬───────────┤
│    SALT    │   NONCE    │    CIPHERTEXT      │  AUTH TAG │
│  16 bytes  │  12 bytes  │    (variable)      │  16 bytes │
└────────────┴────────────┴────────────────────┴───────────┘
             │◄────────── Total: Original + 44 bytes ─────►│
```

### Encryption Details

| Parameter | Value |
|-----------|-------|
| Algorithm | ChaCha20-Poly1305 (AEAD) |
| Key Derivation | PBKDF2-SHA256 |
| Iterations | 100,000 |
| Key Size | 256 bits (32 bytes) |
| Salt Size | 16 bytes (random) |
| Nonce Size | 12 bytes (random) |
| Auth Tag | 16 bytes |

### Encryption Flow

```
Original Data
      │
      ▼
┌─────────────┐
│  Compress   │  (DEFLATE, if beneficial)
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│  Encrypt    │◄────│   Password   │
│ (ChaCha20)  │     │  + PBKDF2    │
└──────┬──────┘     └──────────────┘
       │
       ▼
  Salt + Nonce + Ciphertext + Auth Tag
       │
       ▼
┌─────────────┐
│   Frame     │  (Header flag: ENCRYPTED = 0x02)
└─────────────┘
```

---

## Error Correction

Nedagram v3 uses concatenated FEC (similar to NASA's Voyager):

```
Data ──► RS Encode ──► Scramble ──► Convolutional Encode ──► Symbols
         (outer)       (LFSR)       (inner)
```

### Reed-Solomon (Outer Code)

| Parameter | Value |
|-----------|-------|
| Field | GF(256) |
| Parity Bytes | 16 |
| Error Correction | Up to 8 byte errors per frame |
| Polynomial | x^8 + x^4 + x^3 + x^2 + 1 (0x11D) |

### Convolutional (Inner Code)

| Parameter | Value |
|-----------|-------|
| Constraint Length (K) | 7 |
| Base Rate | 1/2 |
| Punctured Rate | 2/3 |
| Generator G1 | 0x6D (1101101) |
| Generator G2 | 0x4F (1001111) |
| Decoding | Soft-decision Viterbi |

### Scrambler

| Parameter | Value |
|-----------|-------|
| Type | LFSR |
| Polynomial | x^15 + x^14 + 1 |
| Seed | 0x8016 |

For detailed FEC math, see [Technical Specs in README](../README.md#technical-specifications).

---

## Decoder State Machine

```
                              ┌─────────────────┐
                              │                 │
                              ▼                 │
┌──────────┐  Start    ┌─────────────┐          │
│          │ ────────► │             │          │
│   IDLE   │           │  LISTENING  │          │
│          │ ◄──────── │             │          │
└──────────┘   Stop    └──────┬──────┘          │
                              │                 │
                              │ Energy > 0.05   │
                              ▼                 │
                    ┌───────────────────┐       │
                    │                   │       │
                    │    DETECTING      │       │
                    │    PREAMBLE       │───────┤ No chirp found
                    │                   │       │ (timeout)
                    └─────────┬─────────┘       │
                              │                 │
                              │ Chirp + Sync    │
                              │ detected        │
                              ▼                 │
                    ┌───────────────────┐       │
                    │                   │       │
                    │    RECEIVING      │       │
                    │    HEADER         │───────┤ CRC fail (15×)
                    │                   │       │
                    └─────────┬─────────┘       │
                              │                 │
                              │ Header valid    │
                              ▼                 │
                    ┌───────────────────┐       │
                    │                   │       │
                    │    RECEIVING      │───────┘ Frame errors
                    │    DATA           │         (retry/timeout)
                    │                   │
                    └─────────┬─────────┘
                              │
                              │ All frames received
                              ▼
                    ┌───────────────────┐
                    │                   │
                    │     COMPLETE      │
                    │                   │
                    └───────────────────┘
```

### State Descriptions

| State | Description | Exit Conditions |
|-------|-------------|-----------------|
| **IDLE** | Not listening | User starts listening |
| **LISTENING** | Monitoring audio energy | Energy threshold exceeded |
| **DETECTING_PREAMBLE** | Looking for chirp and sync | Chirp matched + sync found |
| **RECEIVING_HEADER** | Extracting header frame | Valid header CRC |
| **RECEIVING_DATA** | Extracting data frames | All frames received |
| **COMPLETE** | Transmission successful | - |
| **ERROR** | Failure (timeout/corruption) | - |

### Detection Parameters

| Parameter | Value |
|-----------|-------|
| Energy Threshold | 0.05 (normalized) |
| Chirp Correlation Threshold | 0.4 (default), 0.3 (adaptive) |
| Sync Pattern Match | ≥70% |
| Silence Timeout | 4 seconds |
| Header Retry Phases | 4 |
| Header Retry Offsets | ±1, ±2 symbols |
| Max Header Failures | 15 (then try other mode) |

---

## Timing Diagrams

### Complete Transmission (Phone Mode, 100 bytes)

```
Time (seconds)
0         2         4         6         8        10        12        14
├─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤
│◄──────────────── PREAMBLE ──────────────────►│
│ Warmup │        Chirp         │ Cal │  Sync  │
│ 0.2s   │        0.8s          │0.4s │  0.4s  │
│        │                      │     │        │
└────────┴──────────────────────┴─────┴────────┴────────────────────────

Time (seconds)
14        20        26        32        38        44        50
├─────────┼─────────┼─────────┼─────────┼─────────┼───────────┤
│◄───── HEADER ─────►│◄────────── DATA FRAMES ───────────►│End│
│     ~8.4s          │         ~30-35s                    │0.4│
│                    │                                    │   │
└────────────────────┴────────────────────────────────────┴───┘

Total: ~50 seconds for 100 bytes (Phone mode)
```

### Symbol Timing Detail

```
Phone Mode (62ms per symbol):

│◄──────────────────── 62ms ────────────────────►│
│                                                │
│  ┌─────────────────────────────────┐  ┌──────┐ │
│  │         Symbol Tone             │  │Guard │ │
│  │           50ms                  │  │ 12ms │ │
│  └─────────────────────────────────┘  └──────┘ │
│  │◄── Fade ──►│           │◄── Fade ──►│       │
│      in                        out             │

Wideband Mode (45ms per symbol):

│◄────────────── 45ms ──────────────►│
│                                    │
│  ┌───────────────────────────┐ ┌──┐│
│  │       Symbol Tone         │ │G ││
│  │          40ms             │ │5 ││
│  └───────────────────────────┘ └──┘│
```

### Preamble Signal Shape

```
Frequency
(Hz)      Phone Mode Preamble (~1.8 seconds)
          │
    2600 ─┤                 ╱╲
          │                ╱  ╲
    2300 ─┤               ╱    ╲     ┌─┐   ┌─┐   ┌─┐   ┌─┐
          │              ╱      ╲    │3│   │3│   │3│   │3│
    1800 ─┤             ╱        ╲ ┌─┤ │ ┌─┤ │ ┌─┤ │ ┌─┤ │
          │            ╱          ╲│2│ │ │2│ │ │2│ │ │2│ │
    1600 ─┼───────────╱            ├─┤ │ ├─┤ │ ├─┤ │ ├─┤ │
          │ Warmup   ╱             │1│ │ │1│ │ │1│ │ │1│ │
    1300 ─┤         ╱              ├─┼─┘ ├─┼─┘ ├─┼─┘ ├─┼─┘
          │        ╱               │0│   │0│   │0│   │0│
     800 ─┤       ╱                └─┘   └─┘   └─┘   └─┘
          │
     600 ─┴───────────────────────────────────────────────────
          0    0.2       0.6      1.0      1.4      1.8
                                                   Time (s)
          │◄─►│◄────────────►│◄──────────►│◄──────────────►│
          Warm   Chirp        Calibration    Sync Pattern
          200ms  800ms           400ms          400ms
```

---

## Appendix: Protocol Constants

```
// Magic bytes
HEADER_MAGIC = "N3" (0x4E 0x33)
DATA_MAGIC   = "D"  (0x44)
VERSION      = 0x03

// Flags
FLAG_COMPRESSED = 0x01
FLAG_ENCRYPTED  = 0x02

// Frame sizes
HEADER_SIZE     = 12 bytes
MAX_PAYLOAD     = 128 bytes per frame
RS_PARITY       = 16 bytes

// Limits
MAX_TOTAL_PAYLOAD = 100 KB
SOFT_LIMIT        = 50 KB (warning)
QR_MAX            = 2 KB

// CRC
CRC16_POLYNOMIAL = 0x1021 (CRC16-CCITT)
CRC16_INIT       = 0xFFFF
```

---

## References

- [README.md](../README.md) - Project overview and technical specs
- [Reed-Solomon](https://en.wikipedia.org/wiki/Reed%E2%80%93Solomon_error_correction) - Outer FEC code
- [Viterbi Algorithm](https://en.wikipedia.org/wiki/Viterbi_algorithm) - Convolutional decoding
- [ChaCha20-Poly1305](https://en.wikipedia.org/wiki/ChaCha20-Poly1305) - AEAD encryption
