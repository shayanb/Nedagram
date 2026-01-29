# Modem Standards Comparison: ITU V.21, V.22 vs Nedagram

This document compares Nedagram's audio modem implementation with classic ITU modem standards (V.21 and V.22) to understand design trade-offs and identify potential improvements.

## Background

ITU V.21 (1964) and V.22 (1980) were designed for data transmission over the Public Switched Telephone Network (PSTN). While these standards are outdated for their original purpose, they provide valuable insights for designing audio-based data transmission systems.

Nedagram faces different challenges than traditional modems:
- **Modern audio codecs** (AMR, Opus, AAC) that are optimized for speech, not data
- **Variable latency** from packet-switched networks
- **No retransmission** capability (one-way broadcast)
- **Speaker-to-microphone** transmission with ambient noise

---

## Technical Specifications Comparison

| Parameter | ITU V.21 | ITU V.22 | Nedagram Phone | Nedagram Wideband |
|-----------|----------|----------|----------------|-------------------|
| **Modulation** | Binary FSK | 4-DPSK (QPSK) | 4-MFSK | 16-MFSK |
| **Bits/Symbol** | 1 | 2 | 2 | 4 |
| **Baud Rate** | 300 | 600 | ~16 | ~22 |
| **Raw Bitrate** | 300 bps | 1200 bps | ~32 bps | ~88 bps |
| **Effective Bitrate** | 300 bps | 1200 bps | ~20-25 bps | ~50-60 bps |
| **Frequency Range** | 980-1850 Hz | 1200-2400 Hz | 800-2300 Hz | 1800-5700 Hz |
| **Tone/Carrier Spacing** | 200 Hz | N/A (phase-based) | 500 Hz | 260 Hz |
| **Symbol Duration** | 3.3 ms | 1.67 ms | 62 ms (50+12 guard) | 45 ms (40+5 guard) |
| **Error Correction** | None | None | Concatenated FEC | Concatenated FEC |
| **Outer Code** | N/A | N/A | RS(n, n-16) | RS(n, n-16) |
| **Inner Code** | N/A | N/A | Conv k=7, rate 2/3 | Conv k=7, rate 2/3 |
| **Scrambling** | None | LFSR | LFSR (x^15+x^14+1) | LFSR (x^15+x^14+1) |
| **Error Tolerance** | 0 bytes | 0 bytes | ~8 bytes + bit errors | ~8 bytes + bit errors |
| **Synchronization** | Continuous | Training sequence | Chirp + calibration | Chirp + calibration |
| **Duplex Mode** | Full | Full | Simplex | Simplex |

### V.21 Frequency Plan
- **Channel 1 (Originate)**: 1080 Hz center, mark=980 Hz, space=1180 Hz
- **Channel 2 (Answer)**: 1750 Hz center, mark=1650 Hz, space=1850 Hz
- **Frequency deviation**: ±100 Hz (200 Hz total shift)

### V.22 Modulation Details
- **Carrier frequencies**: 1200 Hz (low channel), 2400 Hz (high channel)
- **Phase encoding**: 00=+45°, 10=+135°, 11=+225°, 01=+315°
- **Uses scrambler** for DC balance and timing recovery

### Nedagram Phone Mode Frequency Plan
```
Tone 0: 800 Hz
Tone 1: 1300 Hz
Tone 2: 1800 Hz
Tone 3: 2300 Hz
```

### Nedagram Wideband Mode Frequency Plan
```
Tone 0:  1800 Hz    Tone 8:  3880 Hz
Tone 1:  2060 Hz    Tone 9:  4140 Hz
Tone 2:  2320 Hz    Tone 10: 4400 Hz
Tone 3:  2580 Hz    Tone 11: 4660 Hz
Tone 4:  2840 Hz    Tone 12: 4920 Hz
Tone 5:  3100 Hz    Tone 13: 5180 Hz
Tone 6:  3360 Hz    Tone 14: 5440 Hz
Tone 7:  3620 Hz    Tone 15: 5700 Hz
```

---

## Use Case Suitability

| Scenario | V.21 | V.22 | Nedagram Phone | Nedagram Wideband |
|----------|------|------|----------------|-------------------|
| **Traditional PSTN** | Excellent | Good | Good | N/A |
| **GSM Voice Calls** | Poor | Very Poor | **Designed for this** | Poor |
| **VoIP (Opus/AAC)** | Poor | Very Poor | Good | Fair |
| **WhatsApp/Telegram** | Poor | Very Poor | **Good** | Fair |
| **HD Voice (VoLTE)** | Fair | Poor | Good | **Good** |
| **Speaker-to-Mic** | Fair | Poor | Good | **Excellent** |
| **Noisy Environments** | Poor | Poor | **Good** | Good |
| **Transmission Speed** | Fast | Fastest | Slowest | Moderate |

---

## Why V.22's DPSK Fails on Modern Audio

V.22 encodes data in **phase changes** between symbols. Modern audio codecs destroy this because:

1. **Phase is perceptually irrelevant**: Human ears don't perceive absolute phase, so codecs discard it
2. **Variable latency**: Codec frame boundaries cause phase discontinuities
3. **Psychoacoustic modeling**: Codecs apply transforms that alter phase relationships
4. **Dynamic compression**: AGC and limiters in the audio path cause phase shifts

**Result**: V.22 is essentially unusable over VoIP, messaging apps, or any modern compressed audio path.

---

## Why Nedagram's Approach Works

### MFSK vs FSK/DPSK

| Aspect | FSK (V.21) | DPSK (V.22) | MFSK (Nedagram) |
|--------|------------|-------------|-----------------|
| **Codec survival** | Fair | Poor | Good |
| **Phase sensitivity** | None | Critical | None |
| **Frequency sensitivity** | Moderate | Low | Moderate |
| **Noise immunity** | Good | Moderate | Good |
| **Bandwidth efficiency** | Poor | Good | Moderate |

MFSK (Multiple Frequency Shift Keying) encodes data in **which frequency is present**, not in frequency shifts or phase changes. Audio codecs preserve frequency content reasonably well because it's essential for speech intelligibility.

### Wide Tone Spacing (500 Hz in Phone Mode)

GSM/AMR codecs quantize frequency information. With only 200 Hz spacing (like V.21), adjacent tones can blur together after codec processing. Nedagram's 500 Hz spacing ensures clear separation even after codec artifacts.

### Long Symbol Duration (50-62 ms)

| Duration | Benefit |
|----------|---------|
| 3 ms (V.22) | High speed, but sensitive to timing errors |
| 50 ms (Nedagram) | Survives jitter, codec frame boundaries, packet loss |

Codec frames are typically 20 ms. Nedagram's 50 ms symbols span 2-3 codec frames, averaging out frame-to-frame variations.

### Guard Intervals (12 ms)

Traditional modems have no guard intervals because PSTN timing was stable. Modern audio paths have:
- Variable codec latency
- Buffer underruns
- Network jitter

Guard intervals prevent inter-symbol interference when timing varies.

### Concatenated FEC (v3 Protocol)

V.21 and V.22 have **no error correction**. They relied on:
- Relatively clean phone lines
- Ability to request retransmission (ARQ protocols at higher layers)

Nedagram cannot request retransmission (simplex broadcast), so FEC is essential. The v3 protocol uses **concatenated coding** (same approach as Voyager spacecraft):

**Outer Code: Reed-Solomon**
- 16 parity bytes per frame
- Corrects up to 8 byte errors per frame
- Handles burst errors after Viterbi decoding

**Inner Code: Convolutional**
- Constraint length k=7 (64 states)
- Generator polynomials: G1=0x6D, G2=0x4F
- Punctured from rate 1/2 to rate 2/3 (1.5x expansion)
- Soft-decision Viterbi decoding with 35-symbol traceback

**Scrambling**
- LFSR polynomial: x^15 + x^14 + 1
- Ensures good bit distribution for convolutional encoder
- Prevents long runs of identical symbols

**Block Interleaving**
- Spreads burst errors across the frame
- Depth calculated based on frame size

### Chirp Synchronization

Traditional modems use continuous carrier tracking or training sequences. Nedagram's chirp preamble:
- **Detectable in noise**: Matched filter has high SNR gain
- **Survives codecs**: Frequency sweep is preserved even after compression
- **Provides timing**: Sharp correlation peak gives precise sync point
- **Mode detection**: Different chirp parameters for phone vs wideband

---

## Summary

| Standard | Speed | Robustness | Modern Audio | Verdict |
|----------|-------|------------|--------------|---------|
| V.21 | 300 bps | High | Poor | Robust but slow, FSK is codec-hostile |
| V.22 | 1200 bps | Moderate | Very Poor | Faster but DPSK is destroyed by codecs |
| Nedagram Phone | 20-25 bps | High | **Good** | Purpose-built for modern audio paths |
| Nedagram Wideband | 50-60 bps | Moderate | Fair | Optimized for direct transmission |

**Nedagram trades speed for reliability** - the right trade-off when:
- Retransmission is impossible
- Audio path is lossy and unpredictable
- Data integrity is critical

---

## Implemented Improvements from Modem Research

The following techniques from V.21/V.22 have been implemented in Nedagram v3:

### 1. Scrambling ✅ Implemented
V.22 uses an LFSR scrambler to ensure regular symbol transitions. Benefits:
- Better timing recovery (guaranteed edges)
- DC balance (prevents speaker/mic coupling issues)
- More uniform spectrum

**Implementation**: LFSR with polynomial x^15 + x^14 + 1, fixed seed 0x4A80

### 2. Soft-Decision Decoding ✅ Implemented
Instead of hard symbol decisions, pass confidence values to FEC decoder:
- Previous: "Symbol is definitely 3"
- Now: "Symbol is 80% likely 3, 15% likely 2"
- Enables more powerful error correction via Viterbi algorithm

**Implementation**: Viterbi decoder accepts soft values (0.0-1.0), uses path metrics for optimal decoding

### 3. Convolutional Coding ✅ Implemented
Inner convolutional code catches bit errors before they become byte errors for RS:
- Constraint length k=7 (same as Voyager, CDMA, WiFi)
- Rate 1/2 base, punctured to 2/3 for efficiency
- Soft-decision Viterbi with 35-symbol traceback

### 4. Frequency Offset Tracking ✅ Implemented
Codecs and analog paths can shift frequencies by ±10-20 Hz. Track and compensate during decoding.

**Implementation**: FrequencyOffsetTracker estimates offset during calibration tones, compensates in detection

## Future Improvements

### Adaptive Mode Selection
Detect channel quality during preamble and automatically select optimal parameters.

---

## References

- [ITU-T V.21 Specification](https://www.itu.int/rec/T-REC-V.21)
- [ITU-T V.22 Specification](https://www.itu.int/rec/T-REC-V.22)
- [3am Systems - V.22 Technical Details](https://www.3amsystems.com/Technical_library/V22)
- [3am Systems - Dial-up Modem Primer](https://www.3amsystems.com/Technical_library/Vxx)

---

## Summary of v3 Protocol Changes

The v3 protocol represents a significant upgrade to Nedagram's error correction capabilities, inspired by ITU modem research and proven space communication techniques:

| Feature | Previous (v2) | Current (v3) |
|---------|---------------|--------------|
| **FEC Structure** | RS only | Concatenated RS + Convolutional |
| **Inner Code** | None | Conv k=7, rate 2/3 (punctured) |
| **Outer Code** | RS(n, n-16) | RS(n, n-16) (unchanged) |
| **Scrambling** | None | LFSR x^15 + x^14 + 1 |
| **Decoding** | Hard-decision | Soft-decision Viterbi |
| **Magic Bytes** | "N1" | "N3" |
| **Overhead** | ~12.5% (RS) | ~25% (RS + Conv) |
| **Error Capability** | 8 bytes/frame | 8+ bytes + bit errors |

### Key Benefits

1. **Better Bit Error Handling**: Convolutional code catches random bit errors before they accumulate into byte errors
2. **Soft-Decision Gains**: ~2-3 dB improvement over hard-decision decoding
3. **Improved Burst Error Tolerance**: Scrambling + interleaving spreads burst errors
4. **Same Frame Format**: Header structure unchanged, only encoding differs

### Why Concatenated Coding?

This is the same approach used by:
- **Voyager spacecraft** (1977) - Still communicating from interstellar space
- **Mars rovers** - Deep space communication
- **CDMA cellular** - Mobile phone standards
- **DVB/WiFi** - Digital broadcasting and wireless networking

The combination of a convolutional inner code (good at random errors) with an RS outer code (good at burst errors) provides robust protection against the mixed error patterns typical of audio transmission.

---

*Document created: January 2026*
*Nedagram version: 3.0 (v3 protocol)*
