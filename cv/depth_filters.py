"""Preview-only edge-guided weighted least squares and static-scene temporal filtering."""
import cv2
import numpy as np


def spatial_depth(depth, gray):
    # Minimize weighted differences of neighboring inverse depths, anchored to observations.
    # Fill only a one-pixel gap with at least three mutually consistent neighbors.
    valid = np.isfinite(depth)
    inverse = np.zeros_like(depth)
    np.divide(1, depth, out=inverse, where=valid)
    guide = gray.astype(np.float32)
    padded = np.pad(guide, 1, mode="edge")
    h, w = guide.shape
    offsets = [(0,1),(2,1),(1,0),(1,2)]
    weights = [np.exp(-np.abs(guide-padded[y:y+h,x:x+w])/10) for y,x in offsets]
    def neighbors(array):
        p = np.pad(array,1)
        return [p[y:y+h,x:x+w] for y,x in offsets]
    samples = neighbors(inverse)
    supported = [(s > 0) & (g > .5) for s,g in zip(samples,weights)]
    low = np.minimum.reduce([np.where(ok,s,np.inf) for s,ok in zip(samples,supported)])
    high = np.maximum.reduce([np.where(ok,s,0) for s,ok in zip(samples,supported)])
    allowed = valid | ((np.sum(supported,axis=0)>=3) & (high<=1.12*low))
    weights = [g*ok*((~valid) | (s==0) | (np.abs(s-inverse)<=.15*inverse))
               for g,ok,s in zip(weights,neighbors(allowed),samples)]
    denom = valid.astype(np.float32) + sum(weights)
    support_count = np.sum(supported,axis=0)
    seed = sum(s*ok for s,ok in zip(samples,supported))
    estimate = np.divide(seed,support_count,out=inverse.copy(),where=allowed & ~valid)
    for _ in range(4):
        rhs = inverse + sum(g*s for g,s in zip(weights,neighbors(estimate)))
        estimate = np.divide(rhs,denom,out=np.zeros_like(depth),where=allowed & (denom>0))
    return np.divide(1,estimate,out=np.full_like(depth,np.nan),where=estimate>0)


class StaticMedian:
    def __init__(self):
        self.frames = []

    def apply(self, key, stamp, gray, depth):
        if self.frames and (self.frames[-1][0]!=key or not 0 < stamp-self.frames[-1][1] < 750):
            self.frames.clear()
        result = depth
        if len(self.frames)==2:
            g1,d1 = self.frames[0][2:]
            g2,d2 = self.frames[1][2:]
            change = np.maximum(cv2.absdiff(gray,g1),cv2.absdiff(gray,g2))
            stable = cv2.dilate(change,np.ones((5,5),np.uint8)) < 12
            values = np.stack((d1,d2,depth))
            stable &= np.all(np.isfinite(values),axis=0) & (values.max(0)<=values.min(0)*1.15)
            result = np.where(stable,np.median(values,axis=0),depth)
        self.frames = self.frames[-1:]+[(key,stamp,gray,depth)]
        return result
