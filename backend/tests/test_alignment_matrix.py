"""The transform returned by an alignment is plain JSON numbers: no negative zeros."""
import json
import math

import numpy as np

from app.services.alignment import to_matrix4


def test_matrix_has_no_negative_zero():
    R = np.array([[1.0, -0.0, -1e-9], [-0.0, 1.0, 0.0], [1e-9, -0.0, 1.0]])
    t = np.array([-0.0, -1e-12, 2.5])
    M = to_matrix4(R, t)
    flat = [v for row in M for v in row]
    assert all(math.copysign(1.0, v) > 0 for v in flat if v == 0), M
    assert "-0.0" not in json.dumps(M)
    assert M[2][3] == 2.5 and M[3] == [0.0, 0.0, 0.0, 1.0]
