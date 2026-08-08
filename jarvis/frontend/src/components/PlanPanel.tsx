export function PlanPanel({ plan }: { plan: string[] }) {
  if (plan.length === 0) return null;

  return (
    <section className="panel plan-panel">
      <h2 className="panel__title">Task Plan</h2>
      <ol className="plan-panel__list">
        {plan.map((step, i) => (
          <li key={i} className="plan-panel__step">
            {step}
          </li>
        ))}
      </ol>
    </section>
  );
}
