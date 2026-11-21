// The worker encodes finite depths as 32 (far) through 255 (near); zero is unknown.
function depthColors(stops) {
  const colors = stops.split(' ').map(hex => [0,2,4].map(i => parseInt(hex.slice(i,i+2),16)));
  const lut = new Uint8ClampedArray(256*3);
  for (let gray=1; gray<=255; gray++) {
    const t = Math.max(0,(gray-32)/223)*(colors.length-1);
    const lo = Math.floor(t), hi = Math.min(lo+1,colors.length-1);
    for (let c=0;c<3;c++) lut[gray*3+c] = colors[lo][c]+(colors[hi][c]-colors[lo][c])*(t-lo);
  }
  return lut;
}
const depthPalettes = {
  turbo:depthColors('30123b 4040a2 466be3 4294ff 28bceb 18ddc2 32f298 6dfe62 a4fc3c cbed34 ecd13a fdae35 fb8122 ec530f d23105 ac1701 7a0403'),
  viridis:depthColors('440154 48186a 472d7b 424086 3b528b 33638d 2c728e 26828e 21918c 1f9f88 27ad81 3dbc74 5cc863 81d34d aadc32 d5e21a fde725')
};

export function createPerceptionView($, signal) {
  const sample = [
    {label:'Chair', camera:'A', distance:1.4, position:'Center', box:[36,22,33,77]},
    {label:'Desk', camera:'A', distance:2.3, position:'Right', box:[78,32,22,65], align:'right'},
    {label:'Backpack', camera:'B', distance:1.8, position:'Left', box:[17,41,21,43]},
    {label:'Water bottle', camera:'B', distance:2.1, position:'Right', box:[65,36,7,24]}
  ];

  let lastDepthFrame, holdTimer;
  signal?.addEventListener('abort', () => clearTimeout(holdTimer), {once:true});

  function depthOptions() {
    return {
      algorithm: $('#depth-algorithm').value,
      low: $('#depth-source').value === 'low',
      spatial: $('#depth-spatial').checked,
      temporal: $('#depth-temporal').checked,
      meters: $('#depth-meters').checked,
      ...($('#depth-plane-overlay').checked ? {planeOverlay:true} : {}),
      fiveMm: 73.025 // Measured span of five printed squares (2⅞ inches), in mm.
    };
  }

  function repaintDepth() {
    if (lastDepthFrame && $('#depth-hold-status').hidden) showDepth(lastDepthFrame.snapshot, lastDepthFrame.preview, false, lastDepthFrame.overlay);
  }

  function makeAnnotations(feeds) {
    feeds.forEach(({node}) => node.querySelector('.overlays').replaceChildren());
    for (const object of sample) {
      const overlay = document.createElement('div');
      overlay.className = 'box';
      overlay.dataset.kind = object.camera === 'A' ? 'obstacle' : 'object';
      overlay.dataset.align = object.align || 'left';
      ['left','top','width','height'].forEach((key,index) => { overlay.style[key] = object.box[index] + '%'; });
      const label = document.createElement('span');
      label.textContent = object.label + ' · ' + object.distance + ' m';
      overlay.append(label);
      feeds.find(feed => feed.side === object.camera).node.querySelector('.overlays').append(overlay);
    }
  }

  function trackedLabel(object) {
    return object.track_id ? object.label + ' #' + object.track_id : object.label;
  }

  function renderDetections(sampleMode, feeds) {
    const stereo = !sampleMode && !$('#stereo-view').hidden && $('#depth-meters').checked;
    $('#metric-heading').hidden = !stereo;
    const list = sampleMode ? sample : feeds.flatMap(feed =>
      (feed.objects ?? []).map(object => ({...object, camera:feed.side})));
    const waiting = !sampleMode && feeds.every(feed => feed.objects == null);
    const rows = list.map(object => {
      const row = document.createElement('tr');
      const value = sampleMode ? object.distance + ' m' : Math.round(object.confidence * 100) + '%';
      const cells = [trackedLabel(object), 'Camera ' + object.camera, value, object.position];
      if (!sampleMode) cells.push(object.relative_depth ?? 'unknown');
      if (stereo) cells.push(Number.isFinite(object.depth_m) ? object.depth_m.toFixed(2) + ' m' : '—');
      for (const text of cells) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    });
    $('#detection-rows').replaceChildren(...rows);
    $('#depth-heading').hidden = sampleMode;
    $('#detection-measure').textContent = sampleMode ? 'Distance' : 'Confidence';
    $('#detection-count').textContent = waiting ? 'Waiting' :
      list.length + (list.length === 1 ? ' object' : ' objects');
    $('#empty-detections').hidden = Boolean(list.length);
    $('#empty-detections').textContent = waiting ? 'Waiting for camera detections.' :
      'No objects detected in the processed views.';
  }

  function showDepth(snapshot, preview, sampleMode, overlay=null) {
    clearTimeout(holdTimer);
    const plane = sampleMode ? null : snapshot?.plane;
    const opt = depthOptions();
    const protrusions = preview && plane?.validated && opt.planeOverlay &&
      snapshot.depth_frame_id && snapshot.depth_frame_id === snapshot.frame_id
      ? (snapshot.unclassified_obstacles ?? [])
        .filter(item => item.semantic_label && item.semantic_label !== 'unknown' && Number.isFinite(item.depth_m))
        .sort((a,b) => a.depth_m-b.depth_m)
        .slice(0,3)
        .map(item => item.semantic_label.replaceAll('_',' ') + ' ' + item.depth_m.toFixed(1) + 'm')
      : [];
    const protrusionStatus = $('#protrusion-status');
    protrusionStatus.textContent = protrusions.join(' · ');
    protrusionStatus.hidden = !protrusions.length;
    const planeStatus = $('#plane-status');
    planeStatus.hidden = !plane;
    planeStatus.textContent = plane ? [plane.validated ? 'Plane OK' : 'Plane Rejected',
      Number.isFinite(plane.pitch_deg) ? 'Pitch '+plane.pitch_deg.toFixed(1)+'°' : null,
      Number.isFinite(plane.holdout_p90_m) ? 'P90 '+(1000*plane.holdout_p90_m).toFixed(1)+' mm' : null
    ].filter(Boolean).join(' · ') : '';
    const notice = $('#depth-hold-status');
    notice.hidden = true;
    const age = lastDepthFrame ? Date.now() - (lastDepthFrame.snapshot.depth_timestamp_ms ?? lastDepthFrame.snapshot.timestamp_ms) : Infinity;
    const waiting = snapshot && (snapshot.stereo_status === 'waiting_for_pair' ||
      (!snapshot.objects && !snapshot.stereo_status));
    if (!preview && !sampleMode && waiting && age >= 0 && age < 3500 &&
        snapshot.depth_rig === lastDepthFrame.snapshot.depth_rig) {
      notice.textContent = 'Last depth frame · '+(age/1000).toFixed(1)+' s ago · waiting for update';
      notice.hidden = false;
      $('#depth-reading').textContent = '';
      $('#depth-coverage').hidden = true;
      $('#depth-scale').textContent = '';
      $('#depth-reticle').hidden = true;
      holdTimer = setTimeout(() => showDepth(snapshot,null,false),Math.min(500,3500-age));
      return;
    }
    lastDepthFrame = preview ? {snapshot, preview, overlay} : null;
    const status = snapshot?.stereo_status ?? (snapshot?.objects ? 'uncalibrated' : 'waiting_for_a');
    const messages = {
      waiting_for_a:'Waiting for a processed Camera A frame.',
      uncalibrated:'Load the calibration for this phone pair to measure depth.',
      size_mismatch:'Depth unavailable · check both phones’ image dimensions against calibration.',
      transport_unvalidated:'Validate this rig in WebRTC mode before enabling depth.',
      waiting_for_pair:snapshot?.waiting_for_camera_clock?.length
        ? 'Waiting for a usable capture timestamp from Camera '+snapshot.waiting_for_camera_clock.join(' and Camera ')+'.'
        : 'Depth waiting for two time-matched camera frames.',
      unavailable:'Depth processing is unavailable. Camera A is still detecting objects.',
      raft_unavailable:'RAFT-Stereo is unavailable. Check the local model and Python dependencies.',
      no_matches:'Depth unavailable · insufficient matching detail in the shared view.'
    };
    $('#stereo-view').hidden = false;
    // Sample feeds never produce depth, so say so instead of reporting a live waiting state.
    $('#stereo-caption').textContent = sampleMode && !preview
      ? 'Sample feeds have no depth. Select Show live cameras to see depth aligned to Camera A.'
      : messages[status] ?? '';
    const canvas = $('#stereo-map');
    canvas.hidden = !preview;
    $('#stereo-caption').hidden = Boolean(preview);
    const size = $('#depth-preview-size');
    size.hidden = !preview;
    const coverage = $('#depth-coverage');
    const fraction = snapshot?.depth_valid_fraction;
    coverage.hidden = !preview || !Number.isFinite(fraction);
    if (!coverage.hidden) coverage.textContent = (100 * fraction).toFixed(1) + '% valid depth';
    const [near, far] = snapshot?.depth_range_m ?? [];
    const palette = $('#depth-palette').value;
    const [nearColor,farColor] = {gray:['bright','dark'],turbo:['red','purple'],viridis:['yellow','purple']}[palette];
    $('#depth-reading').textContent = !opt.meters ? '' : near
      ? (Number.isFinite(snapshot.center_m) ? 'Center: '+snapshot.center_m.toFixed(2)+' m' : 'Center: no reliable depth')
      : 'Waiting for measured depth…';
    $('#depth-reticle').hidden = !(opt.meters && near && preview);
    const range = opt.meters && near ? ' ('+near+' m to '+far+' m)' : '';
    $('#depth-scale').textContent = preview
      ? 'Near: '+nearColor+' · far: '+farColor+range+' · black is unknown' : '';
    if (preview) {
      if (canvas.width !== preview.naturalWidth) canvas.width = preview.naturalWidth;
      if (canvas.height !== preview.naturalHeight) canvas.height = preview.naturalHeight;
      size.textContent = canvas.width + ' × ' + canvas.height + ' px preview';
      const ctx = canvas.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(preview,0,0);
      const lut = depthPalettes[palette];
      if (lut) {
        const frame = ctx.getImageData(0,0,canvas.width,canvas.height);
        for (let i=0;i<frame.data.length;i+=4) {
          const index = frame.data[i]*3;
          frame.data[i] = lut[index];
          frame.data[i+1] = lut[index+1];
          frame.data[i+2] = lut[index+2];
        }
        ctx.putImageData(frame,0,0);
      }
      if (overlay && opt.planeOverlay) ctx.drawImage(overlay,0,0,canvas.width,canvas.height);
      canvas.dataset.frameId = snapshot.depth_frame_id ?? snapshot.frame_id;
      if (snapshot.depth_expires_ms) {
        const lag = Math.max(0, Date.now()-snapshot.depth_timestamp_ms);
        notice.textContent = 'RAFT-Stereo · captured '+(lag/1000).toFixed(1)+' s ago';
        notice.hidden = false;
        holdTimer = setTimeout(() => showDepth(null,null,false),Math.max(0,snapshot.depth_expires_ms-Date.now()));
      }
    } else {
      delete canvas.dataset.frameId;
    }
  }

  function paintCamera(canvas, image, snapshot) {
    const width = canvas.width = image.naturalWidth;
    const height = canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image,0,0);
    const fontSize = Math.max(12, Math.round(Math.max(width,height) / 42));
    ctx.font = '600 ' + fontSize + 'px system-ui';
    ctx.lineWidth = Math.max(2, width / 240);
    ctx.textBaseline = 'top';
    for (const object of [...(snapshot.objects ?? []), ...(snapshot.preview_objects ?? [])]) {
      const {bbox:[x1,y1,x2,y2], confidence, position} = object;
      const x = x1 * width, y = y1 * height;
      ctx.strokeStyle = '#8ce9ff';
      ctx.setLineDash(object.weak ? [5,3] : []);
      ctx.strokeRect(x, y, (x2-x1)*width, (y2-y1)*height);
      ctx.setLineDash([]);
      let caption = trackedLabel(object) + ' · ' + Math.round(confidence*100) + '% · ' + position;
      if ($('#depth-meters').checked) {
        if (Number.isFinite(object.depth_m)) caption += ' · '+object.depth_m.toFixed(2)+' m';
        if (Number.isFinite(object.height_above_plane_m)) caption += ' · H '+object.height_above_plane_m.toFixed(2)+' m';
        const nearest = object.nearest_depth_m;
        if (snapshot.depth_frame_id && snapshot.depth_frame_id === snapshot.frame_id &&
            Number.isFinite(object.depth_m) && Number.isFinite(nearest) &&
            nearest > 0 && nearest <= .85*object.depth_m &&
            object.depth_m-nearest >= .20) {
          caption += ' · min '+nearest.toFixed(2)+'m';
        }
      }
      if (object.intrusion && object.intrusion.expires > Date.now()) {
        caption += ' · may cross from '+object.intrusion.from_side+' (~'+object.intrusion.eta_s.toFixed(1)+' s)';
      }
      const labelWidth = Math.min(width, Math.ceil(ctx.measureText(caption).width) + 8);
      const left = Math.min(x, width-labelWidth);
      const top = Math.max(0, y-fontSize-6);
      ctx.fillStyle = '#8ce9ff';
      ctx.fillRect(left, top, labelWidth, fontSize+6);
      ctx.fillStyle = '#102031';
      ctx.fillText(caption, left+4, top+2, Math.max(1,labelWidth-8));
    }
    const edge = snapshot.road_edge;
    if (edge?.point) {
      const [u,v] = edge.point;
      ctx.strokeStyle = '#ffd44c';
      ctx.beginPath();
      ctx.arc(u*width,v*height,Math.max(5,width/65),0,2*Math.PI);
      ctx.stroke();
    }
    canvas.dataset.frameId = snapshot.frame_id;
  }

  return {makeAnnotations, renderDetections, showDepth, repaintDepth, depthOptions, paintCamera};
}
