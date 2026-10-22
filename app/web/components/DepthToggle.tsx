/** Use Depth Map: on = depth map (and SAM 3 prep where the model needs it); off = the model gets the original video. */
export function DepthToggle(p: { on: boolean; setOn: (on: boolean) => void }) {
  return (
    <div className="row-card prompt">
      <label className="row-head toggle-row">
        <span className="row-text">
          <b>Use Depth Map</b>
          <small>{p.on ? "Yes: motion comes from a depth map; SAM 3 prep where needed" : "No: the model gets your original video, no depth or prep"}</small>
        </span>
        <span className="switch">
          <input type="checkbox" checked={p.on} onChange={(e) => p.setOn(e.target.checked)} aria-label="Use Depth Map on/off" />
          <i />
        </span>
      </label>
    </div>
  );
}
