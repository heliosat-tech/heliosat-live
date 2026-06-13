"""ML residual correction for the MRU ballistic arrival time.

Learns the timing residual the MRU benchmark leaves on the table:

    y = (OMNI propagation delay) - (MRU ballistic delay)   [minutes]

from upstream-only L1 features, on the exact same ACE/OMNI paired record the
existing Arrival-time validation study uses (OMNI high-res 5-min, Timeshift vs
ballistic (x - BSN_x) * Re / speed). See `train.py` for the CLI.
"""
