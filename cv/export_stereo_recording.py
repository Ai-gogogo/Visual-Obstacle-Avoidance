"""Encode timestamped original A/B frame pairs into a side-by-side recording."""
import csv
import sys
from fractions import Fraction
from pathlib import Path

import av
from PIL import Image


def export(directory):
    time_base = Fraction(1, 1000)
    temporary = directory / 'stereo.partial.mp4'
    with (directory / 'timestamps.csv').open() as manifest, av.open(
            str(temporary), 'w', options={'movflags': '+faststart'}) as video:
        stream = video.add_stream('libx264', rate=30)
        stream.pix_fmt = 'yuv420p'
        stream.time_base = stream.codec_context.time_base = time_base
        stream.options = {'crf': '18', 'preset': 'fast', 'bf': '0'}
        first_size = None
        for row in csv.DictReader(manifest):
            with Image.open(directory / row['a_file']) as left, Image.open(directory / row['b_file']) as right:
                size = left.width + right.width, max(left.height, right.height)
                if first_size is None:
                    first_size = size
                    stream.width, stream.height = [n + n % 2 for n in size]
                if size != first_size:
                    raise ValueError('Camera resolution changed during recording.')
                image = Image.new('RGB', (stream.width, stream.height))
                image.paste(left, (0, 0))
                image.paste(right, (left.width, 0))
            frame = av.VideoFrame.from_image(image)
            frame.pts = round(float(row['elapsed_s']) * 1000)
            frame.time_base = time_base
            for packet in stream.encode(frame):
                video.mux(packet)
        if first_size is None:
            raise ValueError('No synchronized pairs.')
        for packet in stream.encode():
            video.mux(packet)
    temporary.replace(directory / 'stereo.mp4')


if __name__ == '__main__':
    export(Path(sys.argv[1]))
