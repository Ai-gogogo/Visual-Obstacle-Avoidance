"""Decode YOLO11 masks in batches to avoid per-box host synchronization on MPS."""

import torch
from ultralytics.engine.results import Results
from ultralytics.models.yolo.segment import SegmentationPredictor
from ultralytics.utils import ops


class MpsSegmentationPredictor(SegmentationPredictor):
    def construct_result(self, pred, img, orig_img, img_path, proto):
        if not len(pred) or not self.args.retina_masks:
            return super().construct_result(pred, img, orig_img, img_path, proto)

        height, width = orig_img.shape[:2]
        boxes = ops.scale_boxes(img.shape[2:], pred[:, :4], orig_img.shape)
        channels, rows, cols = proto.shape
        logits = (pred[:, 6:] @ proto.float().reshape(channels, -1)).reshape(1, -1, rows, cols)
        masks = ops.scale_masks(logits, (height, width))[0] > 0

        # Same rounded, half-open boxes as the native small-batch crop. Broadcasting
        # keeps all four bounds on the GPU until every mask has been cropped.
        left, top, right, bottom = boxes.round().int().view(-1, 4, 1, 1).unbind(1)
        x = torch.arange(width, device=pred.device)[None, None, :]
        y = torch.arange(height, device=pred.device)[None, :, None]
        masks = (masks & ((x >= left) & (x < right)) & ((y >= top) & (y < bottom))).cpu()
        objects = pred[:, :6].cpu()
        keep = masks.flatten(1).any(1)
        if not keep.all():
            masks, objects = masks[keep], objects[keep]
        return Results(orig_img, path=img_path, names=self.model.names, boxes=objects, masks=masks)
