import "./index.css";
import {
  initBv,
  bvApi,
  type BvSession,
  mountShell,
  statRow,
  dataTable,
  card,
  emptyState,
  pill,
  openModal,
  flash,
  fmtMoney,
  fmtDate,
  skeletonCard,
  h,
} from "./bv-init";

interface Plan {
  id: number;
  name: string;
  amount: number;
  period: string;
  enabled: boolean;
}
interface Stats {
  members: number;
  current: number;
  behind: number;
  collected_30d: number;
}
interface Member {
  id: number;
  name: string;
  contact: string | null;
  plan_id: number | null;
  plan_name: string | null;
  plan_amount: number | null;
  plan_period: string | null;
  paid_through: string | null;
  is_current: boolean;
}

let session: BvSession;
let currency = "JMD";
let plansCache: Plan[] = [];

boot();

async function boot() {
  try {
    session = await initBv();
  } catch (err) {
    renderFatal(err);
    return;
  }
  currency = session.merchant.currency_code || "JMD";
  mountShell({
    brandIcon: "users",
    brandLogo: "/logo.svg",
    title: "Membership",
    subtitle: `${session.merchant.name || "Your organisation"} · dues & roster`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "overview", label: "Overview", icon: "users", render: renderOverview },
      { id: "roster", label: "Roster", icon: "user", render: renderRoster },
      { id: "plans", label: "Plans", icon: "settings", render: renderPlans },
    ],
  });
}

function renderFatal(err: unknown) {
  const root = document.getElementById("root")!;
  root.innerHTML = "";
  root.append(
    h(
      "div",
      { class: "bv-fatal" },
      h("strong", null, "Couldn't start"),
      h("p", { class: "bv-muted" }, (err as any)?.message || "No session token found."),
    ),
  );
}

async function renderOverview(host: HTMLElement) {
  host.innerHTML = "";
  host.append(skeletonCard());
  const data = await bvApi<{ plans: Plan[]; stats: Stats }>("/api/overview").catch(() => null);
  host.innerHTML = "";
  if (!data) {
    host.append(emptyState({ icon: "alert", title: "Couldn't load", text: "Please try again." }));
    return;
  }
  plansCache = data.plans;
  const s = data.stats;
  host.append(
    statRow([
      { k: "Members", v: String(s.members), icon: "users" },
      { k: "Current", v: String(s.current), icon: "check", tone: "ok" },
      { k: "Behind", v: String(s.behind), icon: "alert", tone: s.behind > 0 ? "bad" : undefined },
      { k: "Collected · 30d", v: fmtMoney(Number(s.collected_30d), currency), icon: "wallet", tone: "accent" },
    ]),
  );

  host.append(
    card({
      title: "Import from orders",
      action: h("button", { class: "primary", onClick: () => doSync(host) }, "Import members from orders"),
      body: h(
        "p",
        { class: "bv-muted" },
        "Adds customers from your paid orders to the roster as members. Sales aren't counted as dues — record each member's dues from the Roster.",
      ),
    }),
  );

  if (s.behind > 0) {
    host.append(
      card({
        title: "Needs attention",
        body: emptyState({
          icon: "alert",
          title: `${s.behind} member${s.behind === 1 ? "" : "s"} behind on dues`,
          text: "Open the Roster to record their payments.",
        }),
      }),
    );
  }

  if (!data.plans.length) {
    host.append(
      card({
        title: "Get started",
        body: emptyState({
          icon: "settings",
          title: "No dues plan yet",
          text: "Create a plan (amount + period) in the Plans tab, then add members to the roster.",
        }),
      }),
    );
  }
}

async function doSync(host: HTMLElement) {
  const r = await bvApi<{ enrolled: number }>("/api/sync", { method: "POST" }).catch(() => null);
  if (!r) return flash("Sync failed", "error");
  flash(
    r.enrolled
      ? `Added ${r.enrolled} member${r.enrolled === 1 ? "" : "s"} from orders. Record their dues from the Roster.`
      : "No new customers to add.",
    r.enrolled ? "success" : "info",
  );
  renderOverview(host);
}

async function renderRoster(host: HTMLElement) {
  host.innerHTML = "";
  let status = "";
  const seg = h(
    "div",
    { class: "bv-row" },
    ...["", "current", "behind"].map((s) =>
      h(
        "button",
        {
          class: s === status ? "secondary" : "ghost",
          onClick: () => {
            status = s;
            load();
          },
        },
        s === "" ? "All" : s === "current" ? "Current" : "Behind",
      ),
    ),
  );
  const addBtn = h("button", { class: "primary", onClick: () => openAddMember(host) }, "Add member");
  const list = h("div");
  const load = async () => {
    list.innerHTML = "";
    list.append(skeletonCard());
    const d = await bvApi<{ members: Member[] }>(
      `/api/members${status ? `?status=${status}` : ""}`,
    ).catch(() => ({ members: [] as Member[] }));
    list.innerHTML = "";
    list.append(
      d.members.length
        ? dataTable<Member>({
            columns: [
              { head: "Member", cell: (m) => m.name },
              { head: "Contact", cell: (m) => m.contact || "—" },
              { head: "Plan", cell: (m) => m.plan_name || "—" },
              { head: "Paid through", cell: (m) => (m.paid_through ? fmtDate(m.paid_through) : "—") },
              {
                head: "Status",
                cell: (m) =>
                  m.paid_through == null
                    ? pill("new", "")
                    : m.is_current
                      ? pill("current", "ok")
                      : pill("behind", "bad"),
              },
            ],
            rows: d.members,
            rowActions: (m) => h("button", { class: "secondary", onClick: () => openPay(m, host) }, "Record payment"),
          })
        : emptyState({ icon: "users", title: "No members", text: "Add members to start tracking dues." }),
    );
  };
  host.append(card({ title: "Roster", action: h("div", { class: "bv-row" }, seg, addBtn), body: list }));
  load();
}

function openAddMember(host: HTMLElement) {
  const name = h("input", { type: "text", placeholder: "Full name" }) as HTMLInputElement;
  const contact = h("input", { type: "text", placeholder: "Phone or email" }) as HTMLInputElement;
  const planSel = h("select", null, h("option", { value: "" }, "No plan"), ...plansCache.map((p) => h("option", { value: String(p.id) }, p.name))) as HTMLSelectElement;
  let close = () => {};
  const handle = openModal({
    title: "Add member",
    body: h(
      "div",
      { class: "bv-stack" },
      field("Name", name),
      field("Contact", contact),
      field("Plan", planSel),
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Add",
        primary: true,
        onClick: () => {
          if (!name.value.trim()) {
            flash("Name is required", "error");
            return false;
          }
          bvApi("/api/members", {
            method: "POST",
            body: JSON.stringify({ name: name.value.trim(), contact: contact.value.trim() || null, plan_id: planSel.value || null }),
          })
            .then(() => {
              flash("Member added", "success");
              close();
              renderRoster(host);
            })
            .catch((e) => flash(e?.message || "Failed", "error"));
          return false;
        },
      },
    ],
  });
  close = handle.close;
}

function openPay(m: Member, host: HTMLElement) {
  const periods = h("input", { type: "number", min: "1", value: "1" }) as HTMLInputElement;
  let close = () => {};
  const handle = openModal({
    title: `Record payment — ${m.name}`,
    body: h(
      "div",
      { class: "bv-stack" },
      h("p", { class: "bv-muted" }, m.plan_name ? `${m.plan_name} · ${fmtMoney(Number(m.plan_amount || 0), currency)} / ${m.plan_period}` : "No plan assigned — periods will extend by month."),
      field("Periods paid", periods),
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Record",
        primary: true,
        onClick: () => {
          bvApi<{ paid_through: string }>(`/api/members/${m.id}/pay`, {
            method: "POST",
            body: JSON.stringify({ periods: parseInt(periods.value, 10) || 1 }),
          })
            .then((r) => {
              flash(`Recorded. Paid through ${fmtDate(r.paid_through)}.`, "success");
              close();
              renderRoster(host);
            })
            .catch((e) => flash(e?.message || "Failed", "error"));
          return false;
        },
      },
    ],
  });
  close = handle.close;
}

async function renderPlans(host: HTMLElement) {
  host.innerHTML = "";
  host.append(skeletonCard());
  const d = await bvApi<{ plans: Plan[] }>("/api/plans").catch(() => ({ plans: [] as Plan[] }));
  plansCache = d.plans;
  host.innerHTML = "";
  host.append(
    card({
      title: "Dues plans",
      action: h("button", { class: "primary", onClick: () => openPlan(host) }, "New plan"),
      body: d.plans.length
        ? dataTable<Plan>({
            columns: [
              { head: "Plan", cell: (p) => p.name },
              { head: "Amount", num: true, cell: (p) => fmtMoney(Number(p.amount), currency) },
              { head: "Period", cell: (p) => p.period },
              { head: "Status", cell: (p) => (p.enabled ? pill("active", "ok") : pill("off", "")) },
            ],
            rows: d.plans,
            rowActions: (p) => h("button", { class: "ghost", onClick: () => openPlan(host, p) }, "Edit"),
          })
        : emptyState({ icon: "settings", title: "No plans", text: "Create a dues plan to assign to members." }),
    }),
  );
}

function openPlan(host: HTMLElement, plan?: Plan) {
  const name = h("input", { type: "text", value: plan?.name || "" }) as HTMLInputElement;
  const amount = h("input", { type: "number", min: "0", step: "0.01", value: String(plan?.amount ?? 0) }) as HTMLInputElement;
  const period = h(
    "select",
    null,
    ...["month", "week", "year"].map((p) => h("option", { value: p }, p)),
  ) as HTMLSelectElement;
  period.value = plan?.period || "month";
  let close = () => {};
  const handle = openModal({
    title: plan ? "Edit plan" : "New plan",
    body: h("div", { class: "bv-stack" }, field("Name", name), field(`Amount (${currency})`, amount), field("Period", period)),
    actions: [
      { label: "Cancel" },
      {
        label: "Save",
        primary: true,
        onClick: () => {
          bvApi("/api/plans", {
            method: "POST",
            body: JSON.stringify({ id: plan?.id, name: name.value.trim() || "Membership", amount: +amount.value, period: period.value }),
          })
            .then(() => {
              flash("Plan saved", "success");
              close();
              renderPlans(host);
            })
            .catch((e) => flash(e?.message || "Failed", "error"));
          return false;
        },
      },
    ],
  });
  close = handle.close;
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h("div", { class: "bv-field" }, h("label", { class: "bv-label" }, label), input);
}
