"""
anomaly.py — Isolation Forest Anomaly Detector

Uses sklearn IsolationForest to detect statistically unusual transactions.
Features used: amount, hour-of-day (if available), day-of-week
Contamination = 10% (flag top 10% as suspicious)
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler


def run_anomaly_detection(transactions: list[dict]) -> dict:
    """
    Runs Isolation Forest on the transaction dataset.

    Returns:
    {
        "anomalies": [
            {
                "id": ..., "title": ..., "amount": ..., "date": ...,
                "category": ..., "anomaly_score": float (-1 worst, 1 normal),
                "reason": str
            }
        ],
        "total_flagged": int,
        "contamination_rate": float,
        "model_used": "IsolationForest",
        "feature_set": ["amount", "day_of_week", "day_of_month"],
        "insights": { ... }
    }
    """
    if not transactions or len(transactions) < 5:
        return {
            'anomalies': [],
            'total_flagged': 0,
            'contamination_rate': 0.0,
            'model_used': 'IsolationForest',
            'feature_set': [],
            'insights': {'message': 'Insufficient data (need ≥5 transactions)'}
        }

    df = pd.DataFrame(transactions)
    df['date'] = pd.to_datetime(df['date'], errors='coerce')
    df['amount'] = pd.to_numeric(df['amount'], errors='coerce').fillna(0)
    df['abs_amount'] = df['amount'].abs()
    df['day_of_week'] = df['date'].dt.dayofweek.fillna(0)
    df['day_of_month'] = df['date'].dt.day.fillna(15)

    # Feature matrix
    feature_cols = ['abs_amount', 'day_of_week', 'day_of_month']
    X = df[feature_cols].values.astype(float)

    # Normalize
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # Dynamically set contamination (at least 1 anomaly, at most 15%)
    n = len(df)
    contamination = min(0.15, max(1 / n, 0.05))

    model = IsolationForest(
        n_estimators=100,
        contamination=contamination,
        random_state=42
    )
    predictions = model.fit_predict(X_scaled)
    scores = model.score_samples(X_scaled)  # negative: more anomalous

    df['is_anomaly'] = (predictions == -1)
    df['anomaly_score'] = scores

    anomaly_df = df[df['is_anomaly']].copy()
    anomaly_df = anomaly_df.sort_values('anomaly_score')  # most anomalous first

    def _reason(row) -> str:
        """Generate a human-readable anomaly reason."""
        reasons = []
        mean_amount = df['abs_amount'].mean()
        std_amount = df['abs_amount'].std()

        if row['abs_amount'] > mean_amount + 2 * std_amount:
            reasons.append(f"Amount ₹{row['abs_amount']:,.0f} is unusually large (avg: ₹{mean_amount:,.0f})")
        if row['day_of_week'] >= 5:
            reasons.append("Weekend transaction (less common)")
        if row['day_of_month'] <= 2 or row['day_of_month'] >= 28:
            reasons.append("Month boundary transaction")
        if not reasons:
            reasons.append("Statistical outlier in spending pattern")
        return "; ".join(reasons)

    anomalies_list = []
    for _, row in anomaly_df.iterrows():
        anomalies_list.append({
            'id': row.get('id', ''),
            'title': str(row.get('title', 'Unknown')),
            'amount': float(row['amount']),
            'date': str(row.get('date', '')).split('T')[0] if pd.notna(row.get('date')) else '',
            'category': str(row.get('category', 'General')),
            'type': str(row.get('type', '')),
            'anomaly_score': round(float(row['anomaly_score']), 4),
            'severity': 'high' if row['anomaly_score'] < -0.2 else 'medium',
            'reason': _reason(row)
        })

    total_amount_anomalies = float(anomaly_df['abs_amount'].sum())

    return {
        'anomalies': anomalies_list,
        'total_flagged': len(anomalies_list),
        'contamination_rate': round(contamination, 3),
        'model_used': 'IsolationForest',
        'n_estimators': 100,
        'feature_set': feature_cols,
        'insights': {
            'pct_flagged': round(len(anomalies_list) / n * 100, 1),
            'total_amount_in_anomalies': round(total_amount_anomalies, 2),
            'most_anomalous_title': anomalies_list[0]['title'] if anomalies_list else None,
            'has_high_severity': any(a['severity'] == 'high' for a in anomalies_list)
        }
    }
