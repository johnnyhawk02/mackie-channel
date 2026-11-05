// exp, log, log1p and pow exactly as V8 (Chrome, Node) computes Math.exp,
// Math.log, Math.log1p and Math.pow, so the plugin's circuit solve rounds the same way as the
// JS model. Taken from V8's src/base/ieee754.cc (tag 13.6.233.10), which is
// adapted from fdlibm.
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
//
// The original source code covered by the above license above has been
// modified significantly by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved.
// (V8 is BSD-licensed: https://github.com/v8/v8/blob/main/LICENSE)

// Node builds this file with clang's default floating-point contraction (fused
// multiply-adds on arm64), so it must be compiled the same way to round the same.
#pragma clang fp contract(on)

#include "JsMath.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace mackie::jsmath
{
namespace
{
inline uint64_t bitsOf (double d) { uint64_t b; std::memcpy (&b, &d, 8); return b; }
inline double fromBits (uint64_t b) { double d; std::memcpy (&d, &b, 8); return d; }
inline double divide (double a, double b) { return a / b; }
}

#define EXTRACT_WORDS(ix0, ix1, d)               \
  do {                                           \
    uint64_t bits = bitsOf(d); \
    (ix0) = bits >> 32;                          \
    (ix1) = bits & 0xFFFFFFFFu;                  \
  } while (false)

/* Get the more significant 32 bit int from a double.  */

#define GET_HIGH_WORD(i, d)                      \
  do {                                           \
    uint64_t bits = bitsOf(d); \
    (i) = bits >> 32;                            \
  } while (false)

/* Get the less significant 32 bit int from a double.  */

#define GET_LOW_WORD(i, d)                       \
  do {                                           \
    uint64_t bits = bitsOf(d); \
    (i) = bits & 0xFFFFFFFFu;                    \
  } while (false)

/* Set a double from two 32 bit ints.  */

#define INSERT_WORDS(d, ix0, ix1)             \
  do {                                        \
    uint64_t bits = 0;                        \
    bits |= static_cast<uint64_t>(ix0) << 32; \
    bits |= static_cast<uint32_t>(ix1);       \
    (d) = fromBits(bits);       \
  } while (false)

/* Set the more significant 32 bits of a double from an int.  */

#define SET_HIGH_WORD(d, v)                      \
  do {                                           \
    uint64_t bits = bitsOf(d); \
    bits &= 0x0000'0000'FFFF'FFFF;               \
    bits |= static_cast<uint64_t>(v) << 32;      \
    (d) = fromBits(bits);          \
  } while (false)

/* Set the less significant 32 bits of a double from an int.  */

#define SET_LOW_WORD(d, v)                       \
  do {                                           \
    uint64_t bits = bitsOf(d); \
    bits &= 0xFFFF'FFFF'0000'0000;               \
    bits |= static_cast<uint32_t>(v);            \
    (d) = fromBits(bits);          \
  } while (false)


double exp(double x) {
  static const double
      one = 1.0,
      halF[2] = {0.5, -0.5},
      o_threshold = 7.09782712893383973096e+02,  /* 0x40862E42, 0xFEFA39EF */
      u_threshold = -7.45133219101941108420e+02, /* 0xC0874910, 0xD52D3051 */
      ln2HI[2] = {6.93147180369123816490e-01,    /* 0x3FE62E42, 0xFEE00000 */
                  -6.93147180369123816490e-01},  /* 0xBFE62E42, 0xFEE00000 */
      ln2LO[2] = {1.90821492927058770002e-10,    /* 0x3DEA39EF, 0x35793C76 */
                  -1.90821492927058770002e-10},  /* 0xBDEA39EF, 0x35793C76 */
      invln2 = 1.44269504088896338700e+00,       /* 0x3FF71547, 0x652B82FE */
      P1 = 1.66666666666666019037e-01,           /* 0x3FC55555, 0x5555553E */
      P2 = -2.77777777770155933842e-03,          /* 0xBF66C16C, 0x16BEBD93 */
      P3 = 6.61375632143793436117e-05,           /* 0x3F11566A, 0xAF25DE2C */
      P4 = -1.65339022054652515390e-06,          /* 0xBEBBBD41, 0xC5D26BF1 */
      P5 = 4.13813679705723846039e-08,           /* 0x3E663769, 0x72BEA4D0 */
      E = 2.718281828459045;                     /* 0x4005BF0A, 0x8B145769 */

  static volatile double
      huge = 1.0e+300,
      twom1000 = 9.33263618503218878990e-302, /* 2**-1000=0x01700000,0*/
      two1023 = 8.988465674311579539e307;     /* 0x1p1023 */

  double y, hi = 0.0, lo = 0.0, c, t, twopk;
  int32_t k = 0, xsb;
  uint32_t hx;

  GET_HIGH_WORD(hx, x);
  xsb = (hx >> 31) & 1; /* sign bit of x */
  hx &= 0x7FFFFFFF;     /* high word of |x| */

  /* filter out non-finite argument */
  if (hx >= 0x40862E42) { /* if |x|>=709.78... */
    if (hx >= 0x7FF00000) {
      uint32_t lx;
      GET_LOW_WORD(lx, x);
      if (((hx & 0xFFFFF) | lx) != 0)
        return x + x; /* NaN */
      else
        return (xsb == 0) ? x : 0.0; /* exp(+-inf)={inf,0} */
    }
    if (x > o_threshold) return huge * huge;         /* overflow */
    if (x < u_threshold) return twom1000 * twom1000; /* underflow */
  }

  /* argument reduction */
  if (hx > 0x3FD62E42) {   /* if  |x| > 0.5 ln2 */
    if (hx < 0x3FF0A2B2) { /* and |x| < 1.5 ln2 */
      /* TODO(rtoy): We special case exp(1) here to return the correct
       * value of E, as the computation below would get the last bit
       * wrong. We should probably fix the algorithm instead.
       */
      if (x == 1.0) return E;
      hi = x - ln2HI[xsb];
      lo = ln2LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = static_cast<int>(invln2 * x + halF[xsb]);
      t = k;
      hi = x - t * ln2HI[0]; /* t*ln2HI is exact here */
      lo = t * ln2LO[0];
    }
    x = hi - lo;
  } else if (hx < 0x3E300000) {         /* when |x|<2**-28 */
    if (huge + x > one) return one + x; /* trigger inexact */
  } else {
    k = 0;
  }

  /* x is now in primary range */
  t = x * x;
  if (k >= -1021) {
    INSERT_WORDS(
        twopk,
        0x3FF00000 + static_cast<int32_t>(static_cast<uint32_t>(k) << 20), 0);
  } else {
    INSERT_WORDS(twopk, 0x3FF00000 + (static_cast<uint32_t>(k + 1000) << 20),
                 0);
  }
  c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k == 0) {
    return one - ((x * c) / (c - 2.0) - x);
  } else {
    y = one - ((lo - (x * c) / (2.0 - c)) - hi);
  }
  if (k >= -1021) {
    if (k == 1024) return y * 2.0 * two1023;
    return y * twopk;
  } else {
    return y * twopk * twom1000;
  }
}

double log(double x) {
  static const double                      /* -- */
      ln2_hi = 6.93147180369123816490e-01, /* 3fe62e42 fee00000 */
      ln2_lo = 1.90821492927058770002e-10, /* 3dea39ef 35793c76 */
      two54 = 1.80143985094819840000e+16,  /* 43500000 00000000 */
      Lg1 = 6.666666666666735130e-01,      /* 3FE55555 55555593 */
      Lg2 = 3.999999999940941908e-01,      /* 3FD99999 9997FA04 */
      Lg3 = 2.857142874366239149e-01,      /* 3FD24924 94229359 */
      Lg4 = 2.222219843214978396e-01,      /* 3FCC71C5 1D8E78AF */
      Lg5 = 1.818357216161805012e-01,      /* 3FC74664 96CB03DE */
      Lg6 = 1.531383769920937332e-01,      /* 3FC39A09 D078C69F */
      Lg7 = 1.479819860511658591e-01;      /* 3FC2F112 DF3E5244 */

  static const double zero = 0.0;

  double hfsq, f, s, z, R, w, t1, t2, dk;
  int32_t k, hx, i, j;
  uint32_t lx;

  EXTRACT_WORDS(hx, lx, x);

  k = 0;
  if (hx < 0x00100000) { /* x < 2**-1022  */
    if (((hx & 0x7FFFFFFF) | lx) == 0) {
      return -std::numeric_limits<double>::infinity(); /* log(+-0)=-inf */
    }
    if (hx < 0) {
      return std::numeric_limits<double>::signaling_NaN(); /* log(-#) = NaN */
    }
    k -= 54;
    x *= two54; /* subnormal number, scale up x */
    GET_HIGH_WORD(hx, x);
  }
  if (hx >= 0x7FF00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000FFFFF;
  i = (hx + 0x95F64) & 0x100000;
  SET_HIGH_WORD(x, hx | (i ^ 0x3FF00000)); /* normalize x or x/2 */
  k += (i >> 20);
  f = x - 1.0;
  if ((0x000FFFFF & (2 + hx)) < 3) { /* -2**-20 <= f < 2**-20 */
    if (f == zero) {
      if (k == 0) {
        return zero;
      } else {
        dk = static_cast<double>(k);
        return dk * ln2_hi + dk * ln2_lo;
      }
    }
    R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k == 0) {
      return f - R;
    } else {
      dk = static_cast<double>(k);
      return dk * ln2_hi - ((R - dk * ln2_lo) - f);
    }
  }
  s = f / (2.0 + f);
  dk = static_cast<double>(k);
  z = s * s;
  i = hx - 0x6147A;
  w = z * z;
  j = 0x6B851 - hx;
  t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  i |= j;
  R = t2 + t1;
  if (i > 0) {
    hfsq = 0.5 * f * f;
    if (k == 0)
      return f - (hfsq - s * (hfsq + R));
    else
      return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
  } else {
    if (k == 0)
      return f - s * (f - R);
    else
      return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
  }
}

double log1p(double x) {
  static const double                      /* -- */
      ln2_hi = 6.93147180369123816490e-01, /* 3fe62e42 fee00000 */
      ln2_lo = 1.90821492927058770002e-10, /* 3dea39ef 35793c76 */
      two54 = 1.80143985094819840000e+16,  /* 43500000 00000000 */
      Lp1 = 6.666666666666735130e-01,      /* 3FE55555 55555593 */
      Lp2 = 3.999999999940941908e-01,      /* 3FD99999 9997FA04 */
      Lp3 = 2.857142874366239149e-01,      /* 3FD24924 94229359 */
      Lp4 = 2.222219843214978396e-01,      /* 3FCC71C5 1D8E78AF */
      Lp5 = 1.818357216161805012e-01,      /* 3FC74664 96CB03DE */
      Lp6 = 1.531383769920937332e-01,      /* 3FC39A09 D078C69F */
      Lp7 = 1.479819860511658591e-01;      /* 3FC2F112 DF3E5244 */

  static const double zero = 0.0;

  double hfsq, f, c, s, z, R, u;
  int32_t k, hx, hu, ax;

  GET_HIGH_WORD(hx, x);
  ax = hx & 0x7FFFFFFF;

  k = 1;
  if (hx < 0x3FDA827A) {    /* 1+x < sqrt(2)+ */
    if (ax >= 0x3FF00000) { /* x <= -1.0 */
      if (x == -1.0)
        return -std::numeric_limits<double>::infinity(); /* log1p(-1)=+inf */
      else
        return std::numeric_limits<double>::signaling_NaN();  // log1p(x<-1)=NaN
    }
    if (ax < 0x3E200000) {    /* |x| < 2**-29 */
      if (two54 + x > zero    /* raise inexact */
          && ax < 0x3C900000) /* |x| < 2**-54 */
        return x;
      else
        return x - x * x * 0.5;
    }
    if (hx > 0 || hx <= static_cast<int32_t>(0xBFD2BEC4)) {
      k = 0;
      f = x;
      hu = 1;
    } /* sqrt(2)/2- <= 1+x < sqrt(2)+ */
  }
  if (hx >= 0x7FF00000) return x + x;
  if (k != 0) {
    if (hx < 0x43400000) {
      u = 1.0 + x;
      GET_HIGH_WORD(hu, u);
      k = (hu >> 20) - 1023;
      c = (k > 0) ? 1.0 - (u - x) : x - (u - 1.0); /* correction term */
      c /= u;
    } else {
      u = x;
      GET_HIGH_WORD(hu, u);
      k = (hu >> 20) - 1023;
      c = 0;
    }
    hu &= 0x000FFFFF;
    /*
     * The approximation to sqrt(2) used in thresholds is not
     * critical.  However, the ones used above must give less
     * strict bounds than the one here so that the k==0 case is
     * never reached from here, since here we have committed to
     * using the correction term but don't use it if k==0.
     */
    if (hu < 0x6A09E) {                  /* u ~< sqrt(2) */
      SET_HIGH_WORD(u, hu | 0x3FF00000); /* normalize u */
    } else {
      k += 1;
      SET_HIGH_WORD(u, hu | 0x3FE00000); /* normalize u/2 */
      hu = (0x00100000 - hu) >> 2;
    }
    f = u - 1.0;
  }
  hfsq = 0.5 * f * f;
  if (hu == 0) { /* |f| < 2**-20 */
    if (f == zero) {
      if (k == 0) {
        return zero;
      } else {
        c += k * ln2_lo;
        return k * ln2_hi + c;
      }
    }
    R = hfsq * (1.0 - 0.66666666666666666 * f);
    if (k == 0)
      return f - R;
    else
      return k * ln2_hi - ((R - (k * ln2_lo + c)) - f);
  }
  s = f / (2.0 + f);
  z = s * s;
  R = z * (Lp1 +
           z * (Lp2 + z * (Lp3 + z * (Lp4 + z * (Lp5 + z * (Lp6 + z * Lp7))))));
  if (k == 0)
    return f - (hfsq - s * (hfsq + R));
  else
    return k * ln2_hi - ((hfsq - (s * (hfsq + R) + (k * ln2_lo + c))) - f);
}

// Math.pow: V8 calls the system pow (v8::internal::math::pow with
// use_std_math_pow), after these special cases. The call goes through a
// volatile pointer because clang otherwise turns pow (10, x) into exp10 (x),
// which rounds differently.
static double (*volatile systemPow) (double, double) = ::pow;

double pow (double x, double y)
{
    if (std::isnan (y)) return std::numeric_limits<double>::quiet_NaN();
    if (std::isinf (y) && (x == 1 || x == -1)) return std::numeric_limits<double>::quiet_NaN();
    if (std::isnan (x)) x = std::numeric_limits<double>::quiet_NaN();
    if (y == 2) return x * x;
    if (y == 0.5) return std::isinf (x) ? std::numeric_limits<double>::infinity() : std::sqrt (x + 0);
    return systemPow (x, y);
}

} // namespace mackie::jsmath
