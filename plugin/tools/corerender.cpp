// Core-only render: raw mono float32 in -> raw float32 out, the same steps as
// tools/render.js (pad by the latency, trim it off). Optional drive automation:
//   corerender in.f32 out.f32 <drive> [oversample=4] [block=128] [drive2 at-sample]
#include "../Source/MackieChannelCore.h"
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

int main (int argc, char** argv)
{
    if (argc < 4) { std::fprintf (stderr, "usage: corerender in.f32 out.f32 drive [os] [block] [drive2 at]\n"); return 1; }
    FILE* fi = std::fopen (argv[1], "rb"); if (! fi) return 1;
    std::vector<float> x; float b; while (std::fread (&b, 4, 1, fi) == 1) x.push_back (b); std::fclose (fi);
    mackie::Options o; o.drive = std::atof (argv[3]); o.oversample = argc > 4 ? std::atoi (argv[4]) : 4;
    const int block = argc > 5 ? std::atoi (argv[5]) : (int) x.size() + 64;
    const double drive2 = argc > 7 ? std::atof (argv[6]) : -1; const long at = argc > 7 ? std::atol (argv[7]) : -1;
    const double sr = std::getenv ("SR") ? std::atof (std::getenv ("SR")) : 44100;
    mackie::MackieChannel m (sr, o);
    const int tail = (int) std::ceil (m.latencySamples());
    std::vector<float> xx (x.size() + tail, 0.0f), yy (x.size() + tail, 0.0f);
    std::copy (x.begin(), x.end(), xx.begin());
    auto t0 = std::chrono::steady_clock::now();
    for (size_t s = 0; s < xx.size(); s += block)
    {
        if (at >= 0 && (long) s >= at) { mackie::Options o2 = o; o2.drive = drive2; m.setParams (o2); }
        const int n = (int) std::min ((size_t) block, xx.size() - s);
        m.process (xx.data() + s, yy.data() + s, n);
    }
    const double secs = std::chrono::duration<double> (std::chrono::steady_clock::now() - t0).count();
    std::fprintf (stderr, "%.3fx realtime\n", secs / (x.size() / sr));
    FILE* fo = std::fopen (argv[2], "wb"); std::fwrite (yy.data() + tail, 4, x.size(), fo); std::fclose (fo);
}
