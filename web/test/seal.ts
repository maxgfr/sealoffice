// SPDX-License-Identifier: AGPL-3.0-only
// The real seal-crypto wasm, built by `bun run build:crypto`.
import * as seal from '../src/pkg/seal/seal_crypto.js';
import type { SealCrypto } from '../src/crypto';

seal.initSync({ module: await Bun.file(new URL('../src/pkg/seal/seal_crypto_bg.wasm', import.meta.url)).bytes() });

export const crypto: SealCrypto = seal;
