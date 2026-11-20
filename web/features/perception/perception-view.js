export function createPerceptionView($) {
  const sample = [
    {label:'Chair', camera:'A', distance:1.4, position:'Center', box:[36,22,33,77]},
    {label:'Desk', camera:'A', distance:2.3, position:'Right', box:[78,32,22,65], align:'right'},
    {label:'Backpack', camera:'B', distance:1.8, position:'Left', box:[17,41,21,43]},
    {label:'Water bottle', camera:'B', distance:2.1, position:'Right', box:[65,36,7,24]}
  ];

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
    const stereo = !sampleMode && !$('#stereo-view').hidden;
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
    $('.table-wrap').hidden = !list.length;
    $('#empty-detections').hidden = Boolean(list.length);
    $('#empty-detections').textContent = waiting ? 'Waiting for camera detections.' :
      'No objects detected in the processed views.';
  }

  function showDepth(snapshot, preview, sampleMode) {
    const status = snapshot?.stereo_status ?? (snapshot?.objects ? 'uncalibrated' : 'waiting_for_a');
    const messages = {
      waiting_for_a:'Waiting for a processed Camera A frame.',
      uncalibrated:'Load the calibration for this phone pair to measure depth.',
      size_mismatch:'Depth unavailable · check both phones’ image dimensions against calibration.',
      transport_unvalidated:'Validate this rig in WebRTC mode before enabling depth.',
      waiting_for_pair:'Depth waiting for two time-matched camera frames.',
      unavailable:'Depth processing is unavailable. Camera A is still detecting objects.',
      no_matches:'Depth unavailable · insufficient matching detail in the shared view.'
    };
    $('#stereo-view').hidden = sampleMode;
    $('#stereo-caption').textContent = messages[status] ?? '';
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
    $('#depth-scale').textContent = preview
      ? (near ? 'Bright ' + near + ' m · dark ' + far + ' m' : 'Near is bright, far is dark') + ' · black is unknown'
      : '';
    if (preview) {
      canvas.width = preview.naturalWidth;
      canvas.height = preview.naturalHeight;
      size.textContent = canvas.width + ' × ' + canvas.height + ' px preview';
      canvas.getContext('2d').drawImage(preview, 0, 0);
      canvas.dataset.frameId = snapshot.frame_id;
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
      let caption = trackedLabel(object) + ' · ' + Math.round(confidence*100) + '% · ' + position +
        (Number.isFinite(object.depth_m) ? ' · ' + object.depth_m.toFixed(2) + ' m' : '');
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

  return {makeAnnotations, renderDetections, showDepth, paintCamera};
}
