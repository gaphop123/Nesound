# Contributing to NESound

Thanks for considering a contribution! This project is intentionally small
and dependency-free — please keep that spirit in mind.

## Getting set up

```bash
git clone https://github.com/gaphop123/Nesound.git
cd Nesound
npm install
npm test     # runs test/smoke-test.js
npm run build  # regenerates dist/NESound.min.js
```

No bundler/transpiler is used for the library itself — `NESound.js` is
plain, UMD-wrapped ES5-ish JavaScript so it runs unmodified in browsers,
Node, and AudioWorklet scopes alike. Please keep new code in that same
style rather than introducing a build step for the core file.

## Reporting bugs

Open an issue with:
- A minimal register-write sequence that reproduces the problem
- What you expected vs. what you heard/measured
- Browser/Node version

## Pull requests

1. Fork the repo and create a branch off `main`.
2. Keep changes focused — one feature/fix per PR.
3. Run `npm test` and make sure it passes; add a case to
   `test/smoke-test.js` if you're fixing a bug or adding behavior.
4. Update `README.md` / `NESound.d.ts` if you change or add to the public API.
5. Open the PR with a clear description of *why*, not just *what*.

## Scope

This library intentionally covers only the stock 2A03 APU (2 pulse,
triangle, noise, DMC). Expansion audio chips (VRC6, VRC7, FDS, MMC5, N163,
EPSM/YMF288, etc.) are out of scope for this repo — feel free to build them
as separate companion libraries that plug into `NESound`'s mixer pattern.

## Code of conduct

Be respectful, assume good faith, keep discussion focused on the code.
