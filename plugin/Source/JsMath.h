// Math.exp, Math.log, Math.log1p and Math.pow as V8 computes them (see JsMath.cpp).
#pragma once

namespace mackie::jsmath
{
double exp (double x);
double log (double x);
double log1p (double x);
double pow (double x, double y);
}
