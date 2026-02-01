# Nedagram Protocol Roadmap

This document outlines potential protocol improvements for future versions of Nedagram. Each proposal includes justification, implementation approach, and priority assessment.

---

## Current Protocol Limitations

| Limitation | Current Value | Impact |
|------------|---------------|--------|
| Max frames per transmission | 255 | ~32 KB practical limit |
| Fixed FEC overhead | RS(16) + Conv(2/3) | No adaptation to channel quality |
| One-way transmission | No feedback | Cannot request retransmission |
| Unencrypted data integrity | FEC only | No explicit checksum for plaintext |
| Frequency range | 800-5700 Hz | Audible to humans |

---

## Proposed Improvements

### 1. Payload Integrity Check for Unencrypted Data

**Priority: High**

#### Problem

When encryption is disabled, there's no end-to-end checksum on the payload. The system relies solely on FEC to correct errors. While the FEC is robust, uncorrected errors could slip through as plausible but corrupted data.

Encrypted transmissions have the Poly1305 auth tag which catches any corruption. Unencrypted transmissions have no equivalent protection.

#### Proposed Solution

Add a CRC-32 of the original plaintext appended after the final data frame (before end marker), or include it in the header.

```
Option A: Append after data
  [Header] [Data Frames] [CRC32 (4 bytes)] [End Marker]

Option B: Add to header (use reserved bits to signal presence)
  Header byte 2, bit 2: CRC32_PRESENT flag
  Append 4-byte CRC32 to header (16 bytes total)
```

#### Implementation Approach

1. Use one reserved flag bit (0x04) to indicate CRC32 is present
2. Compute CRC32 of original uncompressed plaintext
3. Append 4 bytes after final data frame payload
4. Receiver verifies CRC32 after decompression
5. Backward compatible: older receivers ignore the extra 4 bytes

#### Justification

- Minimal overhead (4 bytes)
- Uses existing reserved bits
- Provides parity with encrypted mode's auth tag
- Critical for data integrity in plaintext mode

---

### 2. Configurable FEC Strength

**Priority: Medium**

#### Problem

Current FEC parameters are fixed:
- Reed-Solomon: 16 parity bytes (corrects 8 byte errors)
- Convolutional: rate 2/3 (punctured from 1/2)

This is a reasonable compromise, but:
- **Clean channels** (devices side-by-side): FEC overhead wastes bandwidth
- **Noisy channels** (bad phone line): May need stronger protection

#### Proposed Solution

Define 2-3 FEC profiles signaled via reserved header bits:

| Profile | RS Parity | Conv Rate | Use Case |
|---------|-----------|-----------|----------|
| **Light** | 8 bytes | 3/4 | Excellent conditions, higher speed |
| **Normal** (current) | 16 bytes | 2/3 | Standard conditions |
| **Heavy** | 32 bytes | 1/2 | Poor conditions, maximum reliability |

#### Implementation Approach

1. Use reserved flag bits (0x04, 0x08) to encode FEC profile (00=normal, 01=light, 10=heavy)
2. Encoder selects profile based on user choice or heuristics (mode selection)
3. Decoder reads profile from header and adjusts FEC decoding accordingly
4. All profiles use same modulation (MFSK), only FEC parameters change

#### Justification

- Addresses both "too slow" and "too unreliable" feedback
- Backward compatible (00 = current behavior)
- Phone mode could default to Heavy, Wideband to Normal
- User override for specific conditions

---

### 3. Extended Payload Capacity

**Priority: Medium-Low**

#### Problem

Header frame count field is 1 byte (max 255 frames). With 128-byte payloads, this limits transmissions to ~32 KB. The protocol advertises 100 KB max, but this requires multiple separate transmissions.

#### Proposed Solution

**Option A: Extended frame count**
- Use a reserved flag to indicate 2-byte frame count
- Increases max to 65,535 frames (~8 MB theoretical)

**Option B: Transmission chaining**
- After end marker, immediately start new preamble for continuation
- Same Session ID links segments
- No protocol change needed, just convention

#### Implementation Approach

Option A is cleaner:
1. Reserved flag bit (0x04 or 0x08) signals extended header
2. If set, frame count is 2 bytes (bytes 3-4) instead of 1
3. Payload/Original length fields shift by 1 byte
4. Header becomes 13 bytes
5. Older decoders fail gracefully (unknown flag)

#### Justification

- Current 32 KB limit is adequate for most use cases (configs, passwords, URLs)
- 100 KB "soft limit" is rarely needed
- Implementation complexity vs. benefit ratio is low
- Recommend: defer until real user demand

---

### 4. Acknowledgment/Retransmission (ARQ)

**Priority: Low**

#### Problem

Nedagram is one-way: sender transmits, receiver either gets it or doesn't. If errors exceed FEC capability, the entire transmission fails. User must manually retry.

#### Proposed Solution

Optional bidirectional mode where receiver sends brief ACK/NAK after transmission:

```
Sender                          Receiver
   │                                │
   │ ──── [Full Transmission] ────► │
   │                                │
   │ ◄──── [ACK or NAK] ─────────── │
   │                                │
   │ ──── [Retransmit if NAK] ────► │
```

#### Implementation Approach

1. New preamble variant signals "ARQ mode" (different chirp signature)
2. Receiver plays short tone sequence: ACK (success) or NAK (failure + frame bitmap)
3. Sender listens for response after end marker
4. If NAK, retransmit failed frames only
5. Requires both devices to have speaker+mic active simultaneously

#### Justification

- Significantly complicates implementation (bidirectional audio)
- Phone calls already have bidirectional audio, but timing is tricky
- Most Nedagram use cases are short messages where retry is acceptable
- Recommend: defer indefinitely, manual retry is sufficient

---

### 5. Ultrasonic/Inaudible Mode

**Priority: Low**

#### Problem

Current modes use audible frequencies (800-5700 Hz). Users may prefer silent transmission when devices are physically nearby.

#### Proposed Solution

New mode using near-ultrasonic frequencies (16-20 kHz):

| Parameter | Ultrasonic Mode |
|-----------|-----------------|
| Frequency Range | 16,000 - 20,000 Hz |
| Tones | 16 (4 bits/symbol) |
| Spacing | 250 Hz |
| Symbol Duration | 30 ms |

#### Implementation Approach

1. New chirp signature (sweep 16-20 kHz) identifies mode
2. Requires explicit user selection (not auto-detected)
3. Falls back to Wideband if ultrasonic fails
4. Device compatibility varies (not all speakers/mics support 18 kHz+)

#### Justification

- Limited device compatibility (older phones, laptops)
- Higher frequencies attenuate faster
- Range would be very short (< 0.5m)
- Niche use case (already quiet in most settings)
- Recommend: defer, possibly never implement

---

## Implementation Priority Summary

| Improvement | Priority | Effort | Backward Compatible |
|-------------|----------|--------|---------------------|
| 1. Payload CRC32 | **High** | Low | Yes (flag bit) |
| 2. Configurable FEC | **Medium** | Medium | Yes (flag bits) |
| 3. Extended Capacity | Medium-Low | Medium | Yes (flag bit) |
| 4. ARQ | Low | High | No (new mode) |
| 5. Ultrasonic | Low | Medium | No (new mode) |

---

## Recommended Roadmap

### v3.1 (Near-term)
- [x] Add CRC32 for unencrypted payloads (implemented in v3.1.2)
- [x] Document reserved flag usage (see below)

### v3.2 (Medium-term)
- [ ] Implement FEC profiles (Light/Normal/Heavy)
- [ ] Add user-selectable FEC strength in UI

### v4.0 (Future, if needed)
- [ ] Extended frame count for >32 KB transmissions
- [ ] Consider ARQ if user feedback demands it
- [ ] Evaluate ultrasonic mode feasibility

---

## Design Principles

1. **Backward compatibility**: New features should use reserved bits/flags so older decoders fail gracefully
2. **Simplicity**: Avoid features that significantly complicate implementation
3. **Real demand**: Only implement features users actually need
4. **Robustness over speed**: Nedagram prioritizes reliability; speed is secondary
5. **Offline-first**: No features requiring internet or external services

---

## Header Flag Definitions (v3.1+)

The header byte 2 contains version (high 4 bits) and flags (low 4 bits):

```
Byte 2: [VVVV][FFFF]
        Version  Flags
```

### Current Flag Usage

| Bit | Hex  | Name | Description |
|-----|------|------|-------------|
| 0 | 0x01 | `FLAG_COMPRESSED` | Data is DEFLATE compressed |
| 1 | 0x02 | `FLAG_ENCRYPTED` | Data is ChaCha20-Poly1305 encrypted |
| 2 | 0x04 | `FLAG_CRC32_PRESENT` | CRC32 appended to payload (unencrypted only) |
| 3 | 0x08 | Reserved | Available for future use |

### CRC32 Implementation (v3.1.2)

When `FLAG_CRC32_PRESENT` (0x04) is set:

1. **Encoder**: Appends 4-byte CRC32 (little-endian) after compressed payload, before framing
2. **Decoder**: Extracts and verifies CRC32 before decompression
3. **Only for unencrypted data**: Encrypted data uses Poly1305 auth tag instead

```
Payload format with CRC32:
  [Compressed Data] [CRC32 (4 bytes LE)]
```

This provides end-to-end integrity verification for unencrypted transmissions, matching the protection that encrypted transmissions get from the Poly1305 authentication tag.
