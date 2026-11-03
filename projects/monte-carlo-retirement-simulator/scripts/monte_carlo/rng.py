"""Seeded standard-normal draws, identical to the web app's generator.

The web simulator (assets/js/monte-carlo/engine.js) uses mulberry32 for uniforms and
the Box-Muller transform (cosine branch) for normals:

    u1 = max(uniform(), 1e-12); u2 = uniform()
    z  = sqrt(-2 ln u1) * cos(2 pi u2)

mulberry32 is counter-based: its k-th output depends only on (seed + k * 0x6D2B79F5)
mod 2**32, so blocks of uniforms are computed here with exact 32-bit numpy integer
arithmetic. The logarithm, square root and cosine use Python's math module (the
platform C library), so a draw can differ from the browser's by a few units in the
last place (about 1e-15) on some platforms; the integer stream is bit-identical.
"""
from __future__ import annotations

import math
import random

from monte_carlo.deps import np, require_numpy
from monte_carlo.models import MAX_SEED, RNG_NAME

_GOLDEN = 0x6D2B79F5
_MASK = 0xFFFFFFFF
_TWO_PI = 2 * math.pi

__all__ = ["MAX_SEED", "RNG_NAME", "SeededNormal", "mulberry32_block", "parse_seed", "random_seed"]


def mulberry32_block(seed: int, start: int, count: int):
    """Uniforms number start+1 .. start+count of mulberry32(seed), as float64 in [0, 1)."""
    require_numpy()
    k = np.arange(start + 1, start + count + 1, dtype=np.uint64)
    a = ((np.uint64(seed & _MASK) + k * np.uint64(_GOLDEN)) & np.uint64(_MASK)).astype(np.uint32)
    t = (a ^ (a >> np.uint32(15))) * (a | np.uint32(1))
    t = t ^ (t + (t ^ (t >> np.uint32(7))) * (t | np.uint32(61)))
    return (t ^ (t >> np.uint32(14))).astype(np.float64) / 4294967296.0


class SeededNormal:
    """Callable returning the same standard-normal sequence as boxMuller(mulberry32(seed))."""

    BLOCK = 1 << 15  # normals per refill

    def __init__(self, seed: int) -> None:
        if not 0 <= int(seed) <= MAX_SEED:
            raise ValueError(f"Seed must be between 0 and {MAX_SEED}.")
        self.seed = int(seed)
        self.name = RNG_NAME
        self._uniforms_used = 0
        self._buffer: list[float] = []
        self._pos = 0
        self.draws = 0

    def _refill(self) -> None:
        u = mulberry32_block(self.seed, self._uniforms_used, 2 * self.BLOCK).tolist()
        self._uniforms_used += 2 * self.BLOCK
        log, sqrt, cos = math.log, math.sqrt, math.cos
        self._buffer = [
            sqrt(-2 * log(max(u[i], 1e-12))) * cos(_TWO_PI * u[i + 1])
            for i in range(0, len(u), 2)
        ]
        self._pos = 0

    def __call__(self) -> float:
        if self._pos >= len(self._buffer):
            self._refill()
        value = self._buffer[self._pos]
        self._pos += 1
        self.draws += 1
        return value


def parse_seed(text: str) -> int | None:
    """Seed text -> integer, or None for a random run (same rule and message as the web app)."""
    trimmed = str(text or "").strip()
    if not trimmed:
        return None
    if not (trimmed.isascii() and trimmed.isdigit() and len(trimmed) <= 10) or int(trimmed) > MAX_SEED:
        raise ValueError(f"Seed must be a whole number from 0 to {MAX_SEED:,}, or blank for a random run.")
    return int(trimmed)


def random_seed() -> int:
    """A fresh seed in [0, MAX_SEED), as the web app draws one for a blank seed."""
    return random.randrange(MAX_SEED)
