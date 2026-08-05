import { useEffect, useMemo, useRef, useState } from "react";
import { ITEM_BY_ID, ITEMS, RECIPES, RECIPE_BY_OUTPUT } from "../game/catalog";
import { difficultySiteRequirements } from "../game/difficulty";
import type { DifficultyLevel } from "../game/types";
import { formatMoney } from "../game/engine";
import { layoutRecipeGraph, type RecipeGraphLayout } from "./recipeGraphLayout";

const ERA_NAMES = ["基础采集", "手工作坊", "机械制造", "电气工业", "电子自动化", "计算与核能", "航天时代", "量子时代", "星门工程"];
const ERA_COLORS = ["#718096", "#4c956c", "#438ab5", "#6772c8", "#8b67bd", "#bd668e", "#c97942", "#3b9c91", "#b28a35"];
const CHANNEL_NAME = "cat-workshop-interface-v1";

interface RecipeInterfaceState {
  unlockedRecipes: string[];
  craftedItems: string[];
  treasuryCoins: number;
  difficulty: DifficultyLevel;
}

type BridgeMessage =
  | { type: "recipe-state"; state: RecipeInterfaceState }
  | { type: "recipe-state-request" };

const overviewLayout = layoutRecipeGraph(ITEMS, RECIPES);

export function RecipeGraphPage() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [bridgeState, setBridgeState] = useState<RecipeInterfaceState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<number | "all">("all");
  const [scale, setScale] = useState(0.48);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.data.type === "recipe-state") setBridgeState(event.data.state);
    };
    channel.postMessage({ type: "recipe-state-request" } satisfies BridgeMessage);
    return () => channel.close();
  }, []);

  const searchMatches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return new Set(ITEMS.filter((item) => !normalized || `${item.name} ${item.id}`.toLocaleLowerCase().includes(normalized)).map((item) => item.id));
  }, [query]);
  const selectedRelations = useMemo(() => {
    if (!selectedId) return { items: new Set<string>(), edges: new Set<string>() };
    const edges = overviewLayout.edges.filter((edge) => edge.source === selectedId || edge.target === selectedId);
    return {
      items: new Set([selectedId, ...edges.flatMap((edge) => [edge.source, edge.target])]),
      edges: new Set(edges.map((edge) => edge.id)),
    };
  }, [selectedId]);
  const unlocked = new Set(bridgeState?.unlockedRecipes ?? []);
  const crafted = new Set(bridgeState?.craftedItems ?? []);
  const difficulty = bridgeState?.difficulty ?? 3;

  const fitLayout = (layout: RecipeGraphLayout, behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const next = Math.max(0.28, Math.min(1, Math.min((viewport.clientWidth - 36) / layout.width, (viewport.clientHeight - 36) / layout.height)));
    setScale(next);
    requestAnimationFrame(() => viewport.scrollTo({ left: 0, top: 0, behavior }));
  };

  return <div className="recipe-page">
    <header className="recipe-toolbar">
      <div className="recipe-brand"><span>🧶</span><div><strong>猫咪工坊配方一图流</strong><small>点击商品只高亮直接原料、成品与关系线</small></div></div>
      <label className="recipe-search"><span>搜索</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="商品名称或 ID" /></label>
      <select value={tier} onChange={(event) => setTier(event.target.value === "all" ? "all" : Number(event.target.value))} aria-label="筛选时代">
        <option value="all">全部时代</option>
        {ERA_NAMES.map((name, index) => <option key={name} value={index}>{index}. {name}</option>)}
      </select>
      <div className="recipe-zoom">
        <button onClick={() => setScale((value) => Math.max(0.28, value - 0.1))}>−</button>
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((value) => Math.min(1.6, value + 0.1))}>＋</button>
        <button onClick={() => fitLayout(overviewLayout)}>全图</button>
      </div>
      <span className="recipe-site-legend">建筑徽章：建筑 ≤ 曼哈顿距离</span>
      <span className={`recipe-connection ${bridgeState ? "online" : "offline"}`}>{bridgeState ? `难度 ${difficulty} · 国库 ${formatMoney(bridgeState.treasuryCoins)}` : "难度 3 只读"}</span>
    </header>

    <div
      className="recipe-viewport"
      ref={viewportRef}
      onClick={(event) => { if (!(event.target as Element).closest(".recipe-node")) setSelectedId(null); }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest(".recipe-node")) return;
        const viewport = viewportRef.current!;
        viewport.setPointerCapture(event.pointerId);
        dragRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      }}
      onPointerMove={(event) => {
        if (!dragRef.current) return;
        const viewport = viewportRef.current!;
        viewport.scrollLeft = dragRef.current.left - (event.clientX - dragRef.current.x);
        viewport.scrollTop = dragRef.current.top - (event.clientY - dragRef.current.y);
      }}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerCancel={() => { dragRef.current = null; }}
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        setScale((value) => Math.max(0.28, Math.min(1.6, value * Math.exp(-event.deltaY * 0.001))));
      }}
    >
      {selectedId && <div className="recipe-focus-heading" aria-live="polite">
        <span>全图保持不变</span><b>·</b><strong>{ITEM_BY_ID.get(selectedId)?.emoji} {ITEM_BY_ID.get(selectedId)?.name}</strong><b>·</b><span>点击空白取消高亮</span>
      </div>}
      <svg className={`recipe-map ${selectedId ? "has-selection" : ""}`} width={overviewLayout.width * scale} height={overviewLayout.height * scale} viewBox={`0 0 ${overviewLayout.width} ${overviewLayout.height}`} role="img" aria-label="65 项商品配方依赖一图流">
        <defs>
          {ERA_COLORS.map((color, index) => <marker key={color} id={`recipe-arrow-${index}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill={color} /></marker>)}
        </defs>
        {ERA_NAMES.map((name, index) => {
          const columnNodes = overviewLayout.nodes.filter((node) => node.tier === index);
          const x = columnNodes[0]?.x ?? 0;
          return <g key={name} className={`recipe-era ${tier !== "all" && tier !== index ? "dim" : ""}`}>
            <rect x={x - 28} y={44} width={224} height={overviewLayout.height - 88} rx={22} fill={`${ERA_COLORS[index]}0d`} stroke={`${ERA_COLORS[index]}44`} />
            <text x={x} y={78} fill={ERA_COLORS[index]}>{index}. {name}</text>
          </g>;
        })}
        <g className="recipe-edges">
          {overviewLayout.edges.map((edge) => {
            const source = ITEM_BY_ID.get(edge.source)!;
            const target = ITEM_BY_ID.get(edge.target)!;
            const matchesFilter = searchMatches.has(edge.source) && searchMatches.has(edge.target)
              && (tier === "all" || source.tier === tier || target.tier === tier);
            const selected = selectedRelations.edges.has(edge.id);
            const dimmed = !matchesFilter || Boolean(selectedId && !selected);
            const points = edge.points.map((point) => `${point.x},${point.y}`).join(" ");
            return <g key={edge.id} className={`${selected ? "selected" : ""} ${dimmed ? "dimmed" : ""}`} data-edge-id={edge.id}>
              <polyline className="recipe-edge-halo" points={points} />
              <polyline className="recipe-edge" points={points} stroke={ERA_COLORS[target.tier]} markerEnd={`url(#recipe-arrow-${target.tier})`} />
            </g>;
          })}
        </g>
        <g className="recipe-nodes">
          {overviewLayout.nodes.map((node) => {
            const item = ITEM_BY_ID.get(node.id)!;
            const recipe = RECIPE_BY_OUTPUT.get(node.id)!;
            const isUnlocked = unlocked.has(recipe.id);
            const isCrafted = crafted.has(item.id);
            const selected = selectedId === item.id;
            const related = selectedRelations.items.has(item.id);
            const matchesFilter = searchMatches.has(item.id) && (tier === "all" || tier === item.tier);
            const dimmed = !matchesFilter || Boolean(selectedId && !related);
            const formula = recipe.inputs.length === 0 ? "资源采集" : recipe.inputs.map((input) => `${ITEM_BY_ID.get(input.itemId)?.emoji}${input.quantity > 1 ? `×${input.quantity}` : ""}`).join(" + ");
            const siteRequirements = difficultySiteRequirements(recipe, difficulty);
            return <g
              key={item.id}
              className={`recipe-node ${selected ? "selected" : ""} ${related && !selected ? "related" : ""} ${dimmed ? "dimmed" : ""}`}
              transform={`translate(${node.x} ${node.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${item.emoji} ${item.name} = ${formula}${siteRequirements.length > 0 ? `；需在${siteRequirements.map((entry) => `${ITEM_BY_ID.get(entry.buildingItemId)?.name}${entry.maxManhattanDistance}格内`).join("、")}` : ""}`}
              onClick={(event) => { event.stopPropagation(); setSelectedId((current) => current === item.id ? null : item.id); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedId((current) => current === item.id ? null : item.id); }}
            >
              <rect width={node.width} height={node.height} rx="13" fill="#fff" stroke={selected ? "#d4a72c" : ERA_COLORS[item.tier]} />
              <rect width="5" height={node.height} rx="3" fill={ERA_COLORS[item.tier]} />
              <text className="recipe-node-emoji" x="16" y="37">{item.emoji}</text>
              <text className="recipe-node-name" x="54" y="27">{item.name}</text>
              <text className="recipe-node-formula" x="54" y="49">{formula}</text>
              <text className="recipe-node-index" x={node.width - 10} y="18" textAnchor="end">#{node.order + 1}</text>
              {siteRequirements.length > 0
                ? <g className="recipe-node-sites" aria-label="制造建筑要求">
                    {siteRequirements.map((requirement, index) => <g key={`${requirement.buildingItemId}-${index}`} transform={`translate(13 ${67 + index * 21})`}>
                      <rect width={node.width - 26} height="18" rx="6" />
                      <text x="7" y="13">{ITEM_BY_ID.get(requirement.buildingItemId)?.emoji} {ITEM_BY_ID.get(requirement.buildingItemId)?.name} ≤ {requirement.maxManhattanDistance} 格</text>
                    </g>)}
                  </g>
                : <text className="recipe-node-site-free" x="14" y="83">普通工位可制造</text>}
              <circle cx={node.width - 14} cy="60" r="5" fill={isCrafted ? "#43a565" : isUnlocked ? "#d4a72c" : "#cdd2d7"} />
            </g>;
          })}
        </g>
      </svg>
    </div>
  </div>;
}
