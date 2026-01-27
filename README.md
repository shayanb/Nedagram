# Nedagram

[فارسی](README-fa.md) | English

**Transfer text over sound** - A Progressive Web App that encodes text into audio signals for transmission between devices using speakers and microphones (e.g. over a phone call).

## Why Nedagram?

Nedagram was built to help share text data when sending files or copy-paste isn't possible. By converting text to audio, you can:

- Share data (config files, long urls, ...) over **phone calls** (cellular, landline, or VoIP)
- Transfer between devices **without any internet connection**
- Work **completely offline** after the first visit
- **Encrypt your data** with password protection

## How It Works

```
┌─────────────┐    Audio     ┌─────────────┐
│   SENDER    │   Waves     │  RECEIVER   │
│             │ ~~~~~~~~>    │             │
│  Text Input │  Speaker     │ Microphone  │
│      ↓      │     to       │      ↓      │
│  Encrypt*   │    Mic       │   Decode    │
│      ↓      │   (phone)    │      ↓      │
│  Compress   │              │  FEC Decode │
│      ↓      │              │      ↓      │
│  FEC Encode │              │  Decompress │
│      ↓      │              │      ↓      │
│  MFSK Audio │              │  Decrypt*   │
└─────────────┘              └─────────────┘
                              * if encrypted
```

1. **Sender** enters text (config file, password, URL, etc.)
2. Optionally encrypts data with a password
3. App compresses and encodes data with error correction
4. Data is modulated into audio tones (MFSK)
5. **Receiver** captures audio via microphone
6. App decodes, corrects errors, and decrypts if needed
7. Both parties verify SHA-256 checksum matches

## Features

- **Offline-First PWA** - Works without internet after first load
- **End-to-End Encryption** - Optional ChaCha20-Poly1305 encryption with password protection
- **Two Audio Modes**
  - **Phone Mode** - Works over standard phone calls (300-3400 Hz)
  - **Wideband Mode** - Faster transmission for direct device-to-device or HD Voice
- **Two FEC Modes**
  - **Normal FEC** - Standard error correction (16 parity bytes)
  - **Robust FEC** - Enhanced for noisy environments (32 parity bytes)
- **Auto-Detection** - Receiver automatically detects transmission mode and FEC settings
- **Compression** - DEFLATE compression reduces transmission time
- **Integrity Verification** - SHA-256 checksum for sender/receiver verification
- **QR Code Fallback** - For small payloads (< 2KB)
- **Multi-Language** - English and Farsi (RTL) support
- **Downloadable Offline Package** - Share the app itself without internet

## Use Cases

### Primary: Sharing Config Files & Credentials
Share configuration files, complex passwords, or long URLs via:
- Regular phone call
- Voice message apps
- Direct speaker-to-microphone

### Other Uses
- Air-gapped computer data transfer
- Backup codes and credentials
- Text messages in radio communications
- Any scenario where network transfer isn't available

## Quick Start

### Sending
1. Open [Nedagram](https://nedagram.com) on the sending device
2. Paste your text or upload a file
3. Select **Phone** (for calls) or **Wideband** (for direct transfer)
4. Select **Normal FEC** or **Robust FEC** (for noisy environments)
5. Optionally enable **Encrypt** and enter a password
6. Click **Generate Audio**
7. Play the audio near the receiving device
8. Share the SHA-256 checksum (and password if encrypted) with the receiver

### Receiving
1. Open [Nedagram](https://nedagram.com) on the receiving device
2. Click **Start Listening**
3. Allow microphone access
4. Wait for the transmission to complete
5. If encrypted, enter the password to decrypt
6. Verify the checksum matches the sender's
7. Copy or save the decoded text

## Technical Specifications

### Phone Mode (300-3400 Hz)
| Parameter | Value |
|-----------|-------|
| Modulation | 8-MFSK (3 bits/symbol) |
| Frequency Range | 600 - 3050 Hz |
| Symbol Duration | 50ms + 8ms guard |
| Effective Bitrate | ~30-35 bps |

### Wideband Mode (HD Voice)
| Parameter | Value |
|-----------|-------|
| Modulation | 16-MFSK (4 bits/symbol) |
| Frequency Range | 1800 - 5700 Hz |
| Symbol Duration | 40ms + 5ms guard |
| Effective Bitrate | ~50-60 bps |

### Error Correction (Reed-Solomon)
| Mode | Parity Bytes | Error Correction |
|------|--------------|------------------|
| Normal FEC | 16 bytes | Up to 8 errors/frame |
| Robust FEC | 32 bytes | Up to 16 errors/frame |

### Encryption (Optional)
| Parameter | Value |
|-----------|-------|
| Cipher | ChaCha20-Poly1305 (AEAD) |
| Key Derivation | PBKDF2-SHA256 (100,000 iterations) |
| Overhead | 44 bytes (16 salt + 12 nonce + 16 auth tag) |

### Limits
- Maximum payload: 100 KB
- Recommended payload: < 50 KB
- QR code available for payloads < 2 KB

## Transmission Time Estimates

| Payload Size | Phone Mode | Wideband Mode |
|--------------|------------|---------------|
| 100 bytes | ~30 sec | ~20 sec |
| 1 KB | ~4 min | ~2.5 min |
| 10 KB | ~40 min | ~25 min |

*Times are approximate and include preamble, headers, and FEC overhead.*

## Tips for Best Results

1. **Quiet environment** - Background noise reduces accuracy
2. **Volume at 70-80%** - Too loud causes distortion, too quiet loses signal
3. **Distance 0.5-1m** - Optimal range for speaker-to-microphone
4. **Keep devices steady** - Movement during transmission can cause errors
5. **Use Robust FEC** - In noisy conditions or over phone calls
6. **Verify checksum** - Always compare SHA-256 to confirm integrity

## Offline Distribution

You can download Nedagram for completely offline use - no internet connection needed after the initial download.

### From the Website
Visit the Help page at [nedagram.com](https://nedagram.com) and click "Download Offline Package" to get a ZIP file containing everything you need.

**Direct download:** [nedagram.com/nedagram-offline.zip](https://nedagram.com/nedagram-offline.zip)

### Manual Build
```bash
# Clone and build
git clone https://github.com/shayanb/nedagram.git
cd nedagram
npm install
npm run build

# The zip file will be at dist/nedagram-offline.zip
```

### Running Offline
1. Extract the ZIP file to a folder
2. Start a local web server:
   ```bash
   # Using Python (recommended)
   python3 -m http.server 8000 --bind 127.0.0.1

   # Using Node.js
   npx serve .

   # Using PHP
   php -S 127.0.0.1:8000
   ```
3. Open **http://127.0.0.1:8000** in your browser

> **Important:** Use `http://127.0.0.1:8000` (not `[::]` or `localhost`) for microphone access to work. For other devices on your network, use your computer's IP address (e.g., `http://192.168.1.x:8000`).

## Development

### Prerequisites
- Node.js 18+
- npm

### Setup
```bash
# Clone repository
git clone https://github.com/shayanb/nedagram.git
cd nedagram

# Install dependencies
npm install

# Start development server (with HTTPS for mic access)
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

### Tech Stack
- **Framework**: Preact + TypeScript
- **Build Tool**: Vite
- **State**: Preact Signals
- **Compression**: pako (DEFLATE)
- **Encryption**: @noble/ciphers (ChaCha20-Poly1305)
- **Error Correction**: Custom Reed-Solomon implementation
- **PWA**: Service Worker with offline caching

## Privacy & Security

- **No telemetry** - No data is sent anywhere
- **No backend** - Entirely client-side
- **Offline capable** - Works without any network after first load
- **Open source** - Audit the code yourself
- **Optional encryption** - Protect sensitive data with a password

## Browser Support

| Browser | Support |
|---------|---------|
| Chrome (Desktop/Android) | Full |
| Firefox | Full |
| Safari (macOS/iOS) | Full |
| Edge | Full |

*Requires microphone permission for receiving.*

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Disclaimer

This software is provided "as is" for educational and research purposes. See [DISCLAIMER.md](DISCLAIMER.md) for full terms.

## Acknowledgments

Built with the goal of helping people communicate freely when traditional methods fail.

---

**Nedagram** - When technology fails, sound finds a way. :telephone_receiver:
