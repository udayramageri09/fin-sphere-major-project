# FinSphere

A personal-finance application: transactions, goals, liabilities, an emergency fund, monthly category budgets, and an analysis service that forecasts, flags unusual transactions, groups spending and scores financial health.

## Architecture

| Part | Technology | Role |
|---|---|---|
| Web app | React + Vite | UI |
| API | Express (`server/`) | authentication, ownership, validation, all database access, proxy to the ML service, assistant |
| Database | PostgreSQL | the single source of persisted financial state |
| ML service | FastAPI (`ml_service/`) | stateless analysis of the transactions the API sends it |

The API reads the signed-in user's data from PostgreSQL and sends it to the ML service. The ML service has no authentication of its own and must only be reachable from the API. Figures come from persisted data and explicit rules, not from a language model; an optional LLM (Groq) is used only to explain results and to help parse statements.

What is machine learning and what is not:

* Forecaster: linear regression (ordinary least squares), fitted per request.
* Anomaly detector: Isolation Forest, fitted per request. It finds unusual money movements; it is not a fraud detector.
* Spending clusters: Ward agglomerative clustering with a fixed k = 3.
* Health score and financial plan: deterministic rules, not trained models.

No model files are stored; every model is fitted on the user's own data at request time. The evaluation uses synthetic data only, so its results are not real-world accuracy claims.

## Documentation

* [ML architecture](docs/ML_ARCHITECTURE.md): components, data flow, trust boundary, the assistant's role
* [ML evaluation](docs/ML_EVALUATION.md): measured results and known limitations
* [Financial logic](docs/FINANCIAL_LOGIC.md): how income, spending, refunds, transfers, DTI and budgets are computed
* [Evaluation suite](ml_service/evaluation/README.md) and its [generated report](ml_service/evaluation/results/EVALUATION_REPORT.md)

## Running

```bash
npm run dev                                       # web app (Vite)
npm run server                                    # API
python -m ml_service.evaluation.run_evaluation    # regenerate the ML evaluation (about 40 s)
```

`npm run build` builds the web app and `npm run lint` runs ESLint.

---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
