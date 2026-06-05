"""
BetIntel — Multi-Model Divergence Dashboard
============================================
Plotly Dash application that visualises today's model_divergence rows.

Panels:
  1. Tri-model probability bars   — BetIntel vs Massey vs Elo per market
  2. Divergence heatmap           — max_divergence by game × prop_type
  3. Consensus edge scatter       — consensus_edge vs betintel_edge, coloured by flag
  4. HIGH-conf callout cards      — CONSENSUS_EDGE rows with card_recommendation

Run:
    python -m divergence.dashboard
    # Listens on http://0.0.0.0:8050

Env vars used:
    DATABASE_URL   — Postgres connection string (from config.py / Railway)
    DASH_PORT      — Override default port 8050
    DASH_DEBUG     — 'true' enables hot reload
"""

import os
import logging
from datetime import date
from typing import Optional

import psycopg2
import psycopg2.extras
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
from dash import Dash, dcc, html, Input, Output, callback
from dash.exceptions import PreventUpdate

log = logging.getLogger("betintel.divergence.dashboard")
logging.basicConfig(level=logging.INFO)

# ── Theme ─────────────────────────────────────────────────────────────────────
_BG       = "#0d1117"
_CARD_BG  = "#161b22"
_ACCENT   = "#58a6ff"
_GREEN    = "#3fb950"
_ORANGE   = "#d29922"
_RED      = "#f85149"
_TEXT     = "#c9d1d9"
_SUBTEXT  = "#8b949e"

COLOR_MAP = {
    "CONSENSUS_EDGE": _GREEN,
    "HIGH_DIVERGE":   _ORANGE,
    "NOISE":          _SUBTEXT,
}

MODEL_COLORS = {
    "BetIntel": _ACCENT,
    "Massey":   _GREEN,
    "Elo":      _ORANGE,
}

# ── DB ────────────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def load_divergence(run_date: Optional[str] = None, sport: str = "wnba") -> pd.DataFrame:
    """
    Load model_divergence rows for a given date and sport.
    Defaults to today.
    """
    target = run_date or str(date.today())
    conn = get_db()
    try:
        df = pd.read_sql("""
            SELECT *
            FROM model_divergence
            WHERE run_date = %(date)s
              AND sport    = %(sport)s
            ORDER BY max_divergence DESC
        """, conn, params={"date": target, "sport": sport})
    except Exception as e:
        log.error(f"load_divergence error: {e}")
        df = pd.DataFrame()
    finally:
        conn.close()
    return df


# ── Chart Builders ────────────────────────────────────────────────────────────

def build_tri_model_bars(df: pd.DataFrame) -> go.Figure:
    """
    Grouped bar chart: BetIntel p_over vs Massey p_over vs Elo p_home
    for each market (label = player_name + prop_type or game matchup).
    """
    if df.empty:
        return _empty_fig("No data")

    labels = df.apply(
        lambda r: f"{r['player_name'] or r['game_id']} / {r['prop_type']}", axis=1
    )

    fig = go.Figure()
    fig.add_trace(go.Bar(
        name="BetIntel",
        x=labels, y=df["betintel_p_over"],
        marker_color=MODEL_COLORS["BetIntel"],
        opacity=0.9,
    ))
    if "massey_p_over" in df.columns:
        fig.add_trace(go.Bar(
            name="Massey",
            x=labels, y=df["massey_p_over"],
            marker_color=MODEL_COLORS["Massey"],
            opacity=0.9,
        ))
    fig.add_trace(go.Bar(
        name="Elo",
        x=labels, y=df["elo_p_home"],
        marker_color=MODEL_COLORS["Elo"],
        opacity=0.9,
    ))
    fig.update_layout(
        **_layout("Tri-Model P(Over) / P(Home)"),
        barmode="group",
        xaxis_tickangle=-40,
    )
    return fig


def build_divergence_heatmap(df: pd.DataFrame) -> go.Figure:
    """
    Heatmap: rows = game_id, cols = prop_type, values = max_divergence.
    """
    if df.empty:
        return _empty_fig("No data")

    pivot = df.pivot_table(
        index="game_id", columns="prop_type",
        values="max_divergence", aggfunc="max"
    ).fillna(0)

    fig = go.Figure(go.Heatmap(
        z=pivot.values.tolist(),
        x=list(pivot.columns),
        y=list(pivot.index),
        colorscale=[
            [0.0, _CARD_BG],
            [0.3, "#1f4068"],
            [0.6, _ORANGE],
            [1.0, _RED],
        ],
        zmin=0, zmax=0.20,
        hoverongaps=False,
        colorbar=dict(title="Max Div", tickfont=dict(color=_TEXT)),
    ))
    fig.update_layout(**_layout("Divergence Heatmap — Max Divergence by Game × Prop"))
    return fig


def build_edge_scatter(df: pd.DataFrame) -> go.Figure:
    """
    Scatter: x = betintel_edge_over, y = consensus_edge.
    Colour = flag. Size = max_divergence * 300.
    """
    if df.empty:
        return _empty_fig("No data")

    sub = df.dropna(subset=["betintel_edge_over", "consensus_edge"]).copy()
    sub["size"] = (sub["max_divergence"].fillna(0) * 300).clip(lower=6)
    sub["color"] = sub["flag"].map(COLOR_MAP).fillna(_SUBTEXT)
    sub["label"] = sub.apply(
        lambda r: f"{r['player_name'] or r['game_id']}/{r['prop_type']}", axis=1
    )

    fig = go.Figure()
    for flag, grp in sub.groupby("flag"):
        fig.add_trace(go.Scatter(
            x=grp["betintel_edge_over"],
            y=grp["consensus_edge"],
            mode="markers",
            name=flag,
            marker=dict(
                size=grp["size"],
                color=COLOR_MAP.get(flag, _SUBTEXT),
                opacity=0.8,
                line=dict(width=1, color=_BG),
            ),
            text=grp["label"],
            hovertemplate="<b>%{text}</b><br>BI Edge: %{x:.3f}<br>Consensus: %{y:.3f}<extra></extra>",
        ))

    fig.add_hline(y=0, line_dash="dash", line_color=_SUBTEXT, opacity=0.4)
    fig.add_vline(x=0, line_dash="dash", line_color=_SUBTEXT, opacity=0.4)
    fig.update_layout(**_layout("Edge Scatter — BetIntel vs Consensus"))
    return fig


def build_callout_cards(df: pd.DataFrame) -> list:
    """
    Returns a list of Dash html.Div cards for CONSENSUS_EDGE rows.
    """
    hits = df[df["flag"].isin(["CONSENSUS_EDGE", "HIGH_DIVERGE"])].head(12)
    if hits.empty:
        return [html.P("No high-confidence picks today.",
                       style={"color": _SUBTEXT, "padding": "1rem"})]

    cards = []
    for _, r in hits.iterrows():
        border_color = COLOR_MAP.get(r["flag"], _SUBTEXT)
        edge_pct = f"{r['consensus_edge']*100:+.1f}%" if pd.notna(r["consensus_edge"]) else "—"
        rec_color = _GREEN if r["card_recommendation"] == "BET_OVER" else (
                    _RED   if r["card_recommendation"] == "BET_UNDER" else _SUBTEXT)
        cards.append(html.Div([
            html.Div([
                html.Span(r["player_name"] or r["game_id"],
                          style={"fontWeight": "700", "color": _TEXT, "fontSize": "0.95rem"}),
                html.Span(f" · {r['prop_type']}",
                          style={"color": _SUBTEXT, "fontSize": "0.85rem"}),
            ]),
            html.Div([
                html.Span("Line ", style={"color": _SUBTEXT}),
                html.Span(str(r["line"]), style={"color": _TEXT}),
                html.Span("  Consensus Edge ", style={"color": _SUBTEXT, "marginLeft": "0.75rem"}),
                html.Span(edge_pct, style={"color": border_color, "fontWeight": "600"}),
            ], style={"marginTop": "4px", "fontSize": "0.85rem"}),
            html.Div([
                html.Span("BetIntel ", style={"color": _SUBTEXT}),
                html.Span(f"{r['betintel_p_over']:.3f}",
                          style={"color": MODEL_COLORS['BetIntel']}),
                html.Span("  Massey ", style={"color": _SUBTEXT, "marginLeft": "0.5rem"}),
                html.Span(f"{r['massey_p_over']:.3f}" if pd.notna(r.get("massey_p_over")) else "—",
                          style={"color": MODEL_COLORS['Massey']}),
                html.Span("  Elo ", style={"color": _SUBTEXT, "marginLeft": "0.5rem"}),
                html.Span(f"{r['elo_p_home']:.3f}",
                          style={"color": MODEL_COLORS['Elo']}),
            ], style={"marginTop": "4px", "fontSize": "0.82rem"}),
            html.Div(
                r["card_recommendation"],
                style={
                    "marginTop": "8px",
                    "display": "inline-block",
                    "padding": "2px 10px",
                    "borderRadius": "4px",
                    "backgroundColor": rec_color + "22",
                    "border": f"1px solid {rec_color}",
                    "color": rec_color,
                    "fontSize": "0.78rem",
                    "fontWeight": "700",
                    "letterSpacing": "0.05em",
                }
            ),
        ], style={
            "backgroundColor": _CARD_BG,
            "border":          f"1px solid {border_color}",
            "borderRadius":    "8px",
            "padding":         "14px 16px",
            "marginBottom":    "10px",
        }))
    return cards


# ── Layout Helpers ────────────────────────────────────────────────────────────

def _layout(title: str) -> dict:
    return dict(
        title=dict(text=title, font=dict(color=_TEXT, size=14)),
        paper_bgcolor=_CARD_BG,
        plot_bgcolor=_BG,
        font=dict(color=_TEXT, size=11),
        margin=dict(l=40, r=20, t=40, b=80),
        legend=dict(bgcolor=_BG, bordercolor=_CARD_BG),
        xaxis=dict(gridcolor="#21262d", zerolinecolor="#21262d"),
        yaxis=dict(gridcolor="#21262d", zerolinecolor="#21262d"),
    )


def _empty_fig(msg: str) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=msg, x=0.5, y=0.5, showarrow=False,
                       font=dict(color=_SUBTEXT, size=14))
    fig.update_layout(**_layout(""))
    return fig


# ── App ───────────────────────────────────────────────────────────────────────

app = Dash(
    __name__,
    title="BetIntel · Divergence Dashboard",
    meta_tags=[{"name": "viewport", "content": "width=device-width, initial-scale=1"}],
)

SPORTS = ["wnba", "nba", "mlb"]

app.layout = html.Div(style={"backgroundColor": _BG, "minHeight": "100vh",
                              "fontFamily": "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
                              "color": _TEXT, "padding": "0 0 40px"}, children=[

    # ── Header ────────────────────────────────────────────────────────────────
    html.Div(style={"borderBottom": f"1px solid #21262d", "padding": "16px 24px",
                    "display": "flex", "alignItems": "center", "gap": "16px"}, children=[
        html.Span("⚡", style={"fontSize": "1.4rem"}),
        html.Span("BetIntel", style={"fontWeight": "800", "fontSize": "1.2rem",
                                      "color": _ACCENT}),
        html.Span("Multi-Model Divergence Dashboard",
                  style={"color": _SUBTEXT, "fontSize": "0.9rem"}),
        html.Div(style={"marginLeft": "auto", "display": "flex", "gap": "12px",
                        "alignItems": "center"}, children=[
            dcc.Dropdown(
                id="sport-select",
                options=[{"label": s.upper(), "value": s} for s in SPORTS],
                value="wnba",
                clearable=False,
                style={"width": "110px", "backgroundColor": _CARD_BG,
                       "color": _TEXT, "border": f"1px solid #30363d"},
            ),
            dcc.DatePickerSingle(
                id="date-picker",
                date=str(date.today()),
                display_format="YYYY-MM-DD",
                style={"backgroundColor": _CARD_BG},
            ),
            html.Button("↻ Refresh", id="refresh-btn", n_clicks=0,
                        style={"backgroundColor": _ACCENT + "22",
                               "border": f"1px solid {_ACCENT}",
                               "color": _ACCENT, "borderRadius": "6px",
                               "padding": "6px 14px", "cursor": "pointer",
                               "fontSize": "0.85rem"}),
        ]),
    ]),

    # ── Summary Stats Row ─────────────────────────────────────────────────────
    html.Div(id="summary-stats", style={"display": "flex", "gap": "12px",
                                         "padding": "16px 24px"}),

    # ── Callout Cards ─────────────────────────────────────────────────────────
    html.Div(style={"padding": "0 24px 16px"}, children=[
        html.H3("HIGH Confidence Picks",
                style={"color": _TEXT, "fontSize": "0.9rem",
                       "fontWeight": "600", "marginBottom": "10px"}),
        html.Div(id="callout-cards"),
    ]),

    # ── Charts ────────────────────────────────────────────────────────────────
    html.Div(style={"display": "grid",
                    "gridTemplateColumns": "1fr 1fr",
                    "gap": "16px",
                    "padding": "0 24px"}, children=[
        dcc.Graph(id="tri-model-bars",   config={"displayModeBar": False}),
        dcc.Graph(id="divergence-heatmap", config={"displayModeBar": False}),
        dcc.Graph(id="edge-scatter",     config={"displayModeBar": False},
                  style={"gridColumn": "1 / -1"}),
    ]),

    # ── Interval for live refresh ─────────────────────────────────────────────
    dcc.Interval(id="auto-refresh", interval=5 * 60 * 1000, n_intervals=0),
])


# ── Callbacks ─────────────────────────────────────────────────────────────────

@callback(
    Output("tri-model-bars",    "figure"),
    Output("divergence-heatmap","figure"),
    Output("edge-scatter",      "figure"),
    Output("callout-cards",     "children"),
    Output("summary-stats",     "children"),
    Input("refresh-btn",   "n_clicks"),
    Input("auto-refresh",  "n_intervals"),
    Input("date-picker",   "date"),
    Input("sport-select",  "value"),
)
def update_all(n_clicks, n_intervals, run_date, sport):
    df = load_divergence(run_date=run_date, sport=sport)

    bars     = build_tri_model_bars(df)
    heatmap  = build_divergence_heatmap(df)
    scatter  = build_edge_scatter(df)
    cards    = build_callout_cards(df)

    # Summary stat pills
    if df.empty:
        stats = [html.Span("No data loaded", style={"color": _SUBTEXT})]
    else:
        total   = len(df)
        high    = int((df["flag"] == "CONSENSUS_EDGE").sum())
        diverge = int((df["flag"] == "HIGH_DIVERGE").sum())
        avg_div = float(df["max_divergence"].mean())

        def pill(label, val, color):
            return html.Div([
                html.Div(str(val), style={"fontSize": "1.5rem", "fontWeight": "700",
                                          "color": color}),
                html.Div(label,   style={"fontSize": "0.72rem", "color": _SUBTEXT,
                                          "marginTop": "2px"}),
            ], style={"backgroundColor": _CARD_BG, "borderRadius": "8px",
                      "padding": "12px 20px", "border": f"1px solid {color}22",
                      "minWidth": "100px", "textAlign": "center"})

        stats = [
            pill("Markets",        total,                _ACCENT),
            pill("Consensus Edges",high,                 _GREEN),
            pill("High Divergence",diverge,              _ORANGE),
            pill("Avg Max Div",    f"{avg_div:.3f}",     _RED),
        ]

    return bars, heatmap, scatter, cards, stats


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port  = int(os.getenv("DASH_PORT",  8050))
    debug = os.getenv("DASH_DEBUG", "false").lower() == "true"
    log.info(f"Starting BetIntel Divergence Dashboard on port {port}")
    app.run(host="0.0.0.0", port=port, debug=debug)
