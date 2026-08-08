import type { ToolActivity } from "../types";

export function ActivityLog({ activity }: { activity: ToolActivity[] }) {
  return (
    <section className="panel activity-log">
      <h2 className="panel__title">Tool Activity</h2>
      <div className="activity-log__list">
        {activity.length === 0 ? (
          <p className="activity-log__empty">No tools used yet this turn.</p>
        ) : (
          activity.map((item, i) => (
            <div key={i} className={`activity-item activity-item--${item.success ? "ok" : "fail"}`}>
              <span className="activity-item__icon">{item.success ? "✓" : "✕"}</span>
              <div className="activity-item__body">
                <span className="activity-item__name">{item.name}</span>
                <span className="activity-item__summary">{item.summary}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
