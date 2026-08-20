import os
os.environ['OMP_NUM_THREADS'] = '1'  # Prevent MKL/BLAS threadpool crash on Anaconda Windows

import numpy as np
import pandas as pd
from sklearn.cluster import AgglomerativeClustering
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import silhouette_score

_CLUSTER_LABELS = {
    0: 'Micro Transactions',
    1: 'Mid-Range Purchases',
    2: 'High-Value Events'
}

_CLUSTER_DESCRIPTIONS = {
    0: 'Small, frequent day-to-day expenses (food, coffee, transit)',
    1: 'Moderate purchases — shopping, subscriptions, utility bills',
    2: 'Large transactions — salary credits, EMI payments, investments'
}


def run_clustering(transactions: list[dict], n_clusters: int = 3) -> dict:
    """
    Runs Agglomerative (Hierarchical) Clustering on transaction amounts.
    Uses Ward linkage — avoids all MKL/BLAS threadpool issues.

    Clusters are sorted by centroid amount: 0=micro, 1=mid, 2=high-value.

    Returns:
    {
        "clusters": [ { id, label, description, centroid_amount, transaction_count, ... } ],
        "labeled_transactions": [ { ...txn, cluster_id, cluster_label } ],
        "model_metrics": { silhouette_score, n_clusters, algorithm },
        "insights": { dominant_cluster, high_value_exposure_pct, ... }
    }
    """
    if not transactions or len(transactions) < n_clusters:
        return {
            'clusters': [],
            'labeled_transactions': [],
            'model_metrics': {},
            'insights': {'message': f'Need at least {n_clusters} transactions for clustering'}
        }

    df = pd.DataFrame(transactions)
    df['amount'] = pd.to_numeric(df['amount'], errors='coerce').fillna(0)
    df['abs_amount'] = df['amount'].abs()
    df['is_expense'] = (df['amount'] < 0).astype(float)

    X = df[['abs_amount', 'is_expense']].values.astype(float)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    actual_k = min(n_clusters, len(df))

    # AgglomerativeClustering — no threading issues
    model = AgglomerativeClustering(n_clusters=actual_k, linkage='ward')
    raw_labels = model.fit_predict(X_scaled)
    df['cluster_id_raw'] = raw_labels

    # Compute per-cluster centroid amounts manually (no cluster_centers_ in agglomerative)
    centroid_amounts = []
    for cid in range(actual_k):
        mask = df['cluster_id_raw'] == cid
        centroid_amounts.append(float(df.loc[mask, 'abs_amount'].mean()) if mask.sum() > 0 else 0.0)

    # Sort clusters: smallest amount = 0, largest = 2
    cluster_order = np.argsort(centroid_amounts)
    cluster_remap = {int(old): int(new) for new, old in enumerate(cluster_order)}
    df['cluster_id'] = df['cluster_id_raw'].map(cluster_remap)

    # Silhouette score
    sil_score = 0.0
    if actual_k >= 2 and len(df) > actual_k:
        try:
            sil_score = float(silhouette_score(X_scaled, raw_labels))
        except Exception:
            sil_score = 0.0

    # Inertia proxy
    inertia = 0.0
    for cid in range(actual_k):
        mask = (df['cluster_id'].values == cid)
        if mask.sum() > 0:
            centroid = X_scaled[mask].mean(axis=0)
            diffs = X_scaled[mask] - centroid
            inertia += float((diffs ** 2).sum())

    total_amount = float(df['abs_amount'].sum())

    clusters_out = []
    for cid in range(actual_k):
        cdf = df[df['cluster_id'] == cid]
        if cdf.empty:
            continue
        examples = cdf.nlargest(3, 'abs_amount')[['title', 'amount', 'date', 'category']].copy()
        examples['amount'] = examples['amount'].round(2)
        clusters_out.append({
            'id': cid,
            'label': _CLUSTER_LABELS.get(cid, f'Cluster {cid}'),
            'description': _CLUSTER_DESCRIPTIONS.get(cid, ''),
            'centroid_amount': round(float(cdf['abs_amount'].mean()), 2),
            'transaction_count': int(len(cdf)),
            'total_amount': round(float(cdf['abs_amount'].sum()), 2),
            'pct_of_total': round(float(cdf['abs_amount'].sum() / total_amount * 100), 1) if total_amount > 0 else 0,
            'examples': examples.to_dict(orient='records')
        })

    labeled_txns = []
    for _, row in df.iterrows():
        cid = int(row['cluster_id'])
        labeled_txns.append({
            'id': row.get('id', ''),
            'title': str(row.get('title', '')),
            'amount': float(row['amount']),
            'date': str(row.get('date', '')),
            'category': str(row.get('category', '')),
            'cluster_id': cid,
            'cluster_label': _CLUSTER_LABELS.get(cid, f'Cluster {cid}')
        })

    dominant = max(clusters_out, key=lambda c: c['transaction_count']) if clusters_out else None
    high_value_pct = next((c['pct_of_total'] for c in clusters_out if c['id'] == 2), 0)

    return {
        'clusters': clusters_out,
        'labeled_transactions': labeled_txns,
        'model_metrics': {
            'silhouette_score': round(sil_score, 4),
            'inertia_proxy': round(inertia, 2),
            'n_clusters': actual_k,
            'algorithm': 'AgglomerativeClustering (Ward linkage)',
            'note': 'Hierarchical clustering — deterministic, no random seed needed'
        },
        'insights': {
            'dominant_cluster': dominant['label'] if dominant else None,
            'dominant_cluster_pct': dominant['pct_of_total'] if dominant else 0,
            'high_value_exposure_pct': high_value_pct,
            'spending_fragmentation': 'concentrated' if (dominant and dominant['pct_of_total'] > 60) else 'balanced'
        }
    }
