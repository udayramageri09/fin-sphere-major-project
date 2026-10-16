/* eslint-disable react-refresh/only-export-components, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { accountHeaders, refuseIfAccountChanged } from '../utils/accountGuard';
import { useGuardedFetch } from '../hooks/useGuardedFetch';
import { useAuth } from './AuthContext';
import { summarizeTransactions } from '../utils/finance';
import { localDateString } from '../utils/localDate';
import { requestImageText } from '../utils/imageOcr';
import { requestImportConfirm, normalizePreview } from '../utils/duplicateReview';

const FinanceContext = createContext(null);

export const useFinance = () => {
  const context = useContext(FinanceContext);
  if (!context) {
    throw new Error('useFinance must be used within a FinanceProvider');
  }
  return context;
};

export const FinanceProvider = ({ children, currentView, setCurrentView }) => {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // goalsLoading starts true so the first paint is "loading", never a false "no goals yet".
  const [goals, setGoals] = useState([]);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [goalsError, setGoalsError] = useState(null);
  // Same for liabilities. All of this state lives in the provider, which App only renders
  // while authenticated, so logging out (or losing the session) discards it.
  const [liabilities, setLiabilities] = useState([]);
  const [liabilitiesLoading, setLiabilitiesLoading] = useState(true);
  const [liabilitiesError, setLiabilitiesError] = useState(null);
  // The emergency fund is one record per user. emergencyFund is null until the first load finishes, then
  // { configured: false, ... } (nothing saved) or { configured: true, currentAmount, targetAmount, ... }.
  const [emergencyFund, setEmergencyFund] = useState(null);
  const [emergencyFundLoading, setEmergencyFundLoading] = useState(true);
  const [emergencyFundError, setEmergencyFundError] = useState(null);
  // Budgets use a single-active-month model: `budgets` always belongs to `budgetsMonth`. A response that arrives
  // after the user switched to another month is ignored (the ref holds the month currently wanted), so a slow
  // request can never overwrite the list of the month being shown. Nothing is fetched until the UI asks.
  const [budgets, setBudgets] = useState([]);
  const [budgetsMonth, setBudgetsMonth] = useState(null);
  const [budgetsLoading, setBudgetsLoading] = useState(false);
  const [budgetsError, setBudgetsError] = useState(null);
  const activeBudgetMonth = useRef(null);
  // Every budget request gets a number; only the newest one may change the list, so neither a switch to another
  // month nor two refreshes of the same month can finish out of order and show older numbers.
  const budgetRequestSeq = useRef(0);
  const { invalidateSession, user, retryIdentityCheck } = useAuth();
  // Every request names the account this tab is showing; the server refuses it if the session now belongs to someone else (utils/accountGuard.js).
  const apiFetch = useGuardedFetch();

  const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

  const fetchTransactions = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_URL}/transactions`, { credentials: 'include' });
      if (res.status === 401) return invalidateSession();
      if (!res.ok) throw new Error('Failed to fetch transactions');
      const data = await res.json();
      setTransactions(data);
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchGoals = async () => {
    setGoalsLoading(true);
    setGoalsError(null);
    try {
      const res = await apiFetch(`${API_URL}/goals`, { credentials: 'include' });
      if (res.status === 401) return invalidateSession();
      if (!res.ok) throw new Error('Failed to load goals');
      setGoals(await res.json());
    } catch (err) {
      console.error(err);
      setGoalsError(err.message);
    } finally {
      setGoalsLoading(false);
    }
  };

  // A 401 also clears any liabilities already held in memory before the session ends.
  const dropLiabilitiesAndEndSession = () => {
    setLiabilities([]);
    setLiabilitiesError(null);
    invalidateSession();
  };

  const fetchLiabilities = async () => {
    setLiabilitiesLoading(true);
    setLiabilitiesError(null);
    try {
      const res = await apiFetch(`${API_URL}/liabilities`, { credentials: 'include' });
      if (res.status === 401) return dropLiabilitiesAndEndSession();
      if (!res.ok) throw new Error('Failed to load liabilities');
      setLiabilities(await res.json());
    } catch (err) {
      console.error(err);
      setLiabilitiesError(err.message);
    } finally {
      setLiabilitiesLoading(false);
    }
  };

  const fetchEmergencyFund = async () => {
    setEmergencyFundLoading(true);
    setEmergencyFundError(null);
    try {
      const res = await apiFetch(`${API_URL}/emergency-fund`, { credentials: 'include' });
      if (res.status === 401) {
        setEmergencyFund(null);
        return invalidateSession();
      }
      if (!res.ok) throw new Error('Failed to load emergency fund');
      setEmergencyFund(await res.json());
    } catch (err) {
      console.error(err);
      setEmergencyFundError(err.message);
    } finally {
      setEmergencyFundLoading(false);
    }
  };

  const dropBudgetsAndEndSession = () => {
    activeBudgetMonth.current = null;
    budgetRequestSeq.current += 1;   // anything still in flight is now stale
    setBudgets([]);
    setBudgetsMonth(null);
    setBudgetsError(null);
    setBudgetsLoading(false);
    invalidateSession();
  };

  // Loads the month's budgets together with their actual spending (computed by the server from the user's
  // transactions). silent = refresh in place without blanking the list (used after a save or delete).
  const loadBudgets = async (month, { silent }) => {
    const seq = ++budgetRequestSeq.current;
    activeBudgetMonth.current = month;
    if (!silent) {
      setBudgetsMonth(month);
      setBudgets([]);            // never show another month's list under this month's heading
      setBudgetsLoading(true);
    }
    setBudgetsError(null);
    try {
      const res = await apiFetch(`${API_URL}/budgets?month=${encodeURIComponent(month)}`, { credentials: 'include' });
      if (res.status === 401) return dropBudgetsAndEndSession();
      if (!res.ok) throw new Error('Failed to load budgets');
      const data = await res.json();
      if (budgetRequestSeq.current !== seq) return;       // superseded by a newer request / another month
      setBudgetsMonth(month);
      setBudgets(data);
    } catch (err) {
      if (budgetRequestSeq.current !== seq) return;
      console.error(err);
      setBudgetsError(err.message);
    } finally {
      if (budgetRequestSeq.current === seq) setBudgetsLoading(false);
    }
  };

  const fetchBudgets = (month) => loadBudgets(month, { silent: false });

  // The ONE place that applies a saved budget to shared state (the manual form and a confirmed assistant action both call
  // it). The saved row has no actual-spending fields, and a changed amount changes remaining / percent / status, so the
  // month on screen is reloaded from the server instead of merging a half-filled row. A budget for ANY OTHER month leaves
  // the visible list untouched (it is fetched when that month is opened).
  const applyBudgetSaved = async (budget) => {
    if (activeBudgetMonth.current === budget.month) await loadBudgets(budget.month, { silent: true });
  };

  // Creates or updates the budget for (month, category). Throws on failure so the form can show the server's
  // validation message; a 401 ends the session. The list is only touched if that month is still the one shown.
  const saveBudget = async (payload) => {
    const res = await apiFetch(`${API_URL}/budgets`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.status === 401) {
      dropBudgetsAndEndSession();
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save budget');
    await applyBudgetSaved(data);
    return data;
  };

  const deleteBudget = async (id) => {
    const res = await apiFetch(`${API_URL}/budgets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    if (res.status === 401) {
      dropBudgetsAndEndSession();
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete budget');
    }
    setBudgets(prev => prev.filter(b => b.id !== id));
    if (activeBudgetMonth.current) await loadBudgets(activeBudgetMonth.current, { silent: true });
  };

  useEffect(() => {
    fetchTransactions();
    fetchGoals();
    fetchLiabilities();
    fetchEmergencyFund();
  }, []);

  // The ONE place that applies a stored write to shared state. The manual forms and a confirmed assistant action both
  // call these, so the Dashboard, Goals and Transactions pages cannot disagree about what the assistant just saved.
  const applyTransactionCreated = (txn) => setTransactions(prev => (prev.some(t => t.id === txn.id) ? prev : [txn, ...prev]));
  const applyGoalUpdated = (goal) => setGoals(prev => prev.map(g => (g.id === goal.id ? goal : g)));
  const applyLiabilityUpdated = (liability) => setLiabilities(prev => prev.map(l => (l.id === liability.id ? liability : l)));
  // A NEW liability (manual form or a confirmed assistant action): newest first, and never twice (a replayed confirmation
  // returns the same stored liability, so its id is already there).
  const applyLiabilityCreated = (liability) => setLiabilities(prev => (prev.some(l => l.id === liability.id) ? prev : [liability, ...prev]));

  const addTransaction = async (txn) => {
    setError(null);
    try {
      const res = await apiFetch(`${API_URL}/transactions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(txn)
      });
      if (res.status === 401) {
        invalidateSession();
        throw new Error('Session expired');
      }
      if (!res.ok) {
        // The server's validation message is safe to show (like the goal / liability / budget writes).
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to add transaction');
      }
      const newTxn = await res.json();
      applyTransactionCreated(newTxn);
      return newTxn;
    } catch (err) {
      console.error(err);
      setError(err.message);
      throw err;
    }
  };

  const deleteTransaction = async (id) => {
    setError(null);
    try {
      const res = await apiFetch(`${API_URL}/transactions/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.status === 401) {
        invalidateSession();
        throw new Error('Session expired');
      }
      if (!res.ok) throw new Error('Failed to delete transaction');
      // The API removes exactly one owned row, even if legacy data repeats an ID, so
      // mirror that: drop only the first local match (IDs compared as strings because
      // historical rows have numeric IDs and new rows have UUID strings).
      setTransactions(prev => {
        const index = prev.findIndex(t => String(t.id) === String(id));
        if (index === -1) return prev;
        const next = [...prev];
        next.splice(index, 1);
        return next;
      });
    } catch (err) {
      console.error(err);
      setError(err.message);
      throw err;
    }
  };

  // The user's correction of ONE transaction's category (the server changes nothing else). The corrected transaction replaces the local
  // one, so every figure built from `transactions` (the dashboard, the spending analytics) is recalculated at once. Throws the server's
  // message on failure; a 401 ends the session. Nothing about the transaction is logged.
  const updateTransaction = async (id, fields) => {
    let res;
    try {
      res = await apiFetch(`${API_URL}/transactions/${encodeURIComponent(id)}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
    } catch { throw new Error('Could not reach the server. Your transaction has not been changed.'); }
    if (res.status === 401) { invalidateSession(); throw new Error('Session expired'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not save the transaction.');
    setTransactions(prev => { const i = prev.findIndex(t => String(t.id) === String(id)); if (i < 0) return prev; const next = [...prev]; next[i] = data; return next; });
    return data;
  };

  const updateTransactionCategory = async (id, category) => {
    let res;
    try {
      res = await apiFetch(`${API_URL}/transactions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category })
      });
    } catch {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    if (res.status === 401) {
      invalidateSession();
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not change the category. Please try again.');
    setTransactions(prev => {
      const index = prev.findIndex(t => String(t.id) === String(id));   // the same first-match rule the server uses
      if (index === -1) return prev;
      const next = [...prev];
      next[index] = data;
      return next;
    });
    return data;
  };

  // Goal create/delete throw on failure so the caller can show the message inline
  // (the server's validation text is passed through); a 401 ends the session.
  const addGoal = async (goal) => {
    const res = await apiFetch(`${API_URL}/goals`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goal)
    });
    if (res.status === 401) {
      invalidateSession();
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to add goal');
    setGoals(prev => [data, ...prev]);
    return data;
  };

  const deleteGoal = async (id) => {
    const res = await apiFetch(`${API_URL}/goals/${id}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    if (res.status === 401) {
      invalidateSession();
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete goal');
    }
    setGoals(prev => prev.filter(g => g.id !== id));
  };

  // Records a contribution toward one goal. The server returns the updated goal, which replaces the matching
  // entry, so the Dashboard and the Goals page (one shared state) stay in sync without a refetch. Throws on
  // failure so the form can show the server's validation message; a 401 ends the session.
  const addGoalContribution = async (goalId, amount) => {
    const res = await apiFetch(`${API_URL}/goals/${encodeURIComponent(goalId)}/contributions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    if (res.status === 401) {
      invalidateSession();
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to add contribution');
    applyGoalUpdated(data.goal);
    return data;
  };

  // Liability create/delete throw on failure so the caller can show the message inline
  // (the server's validation text is passed through); a 401 ends the session.
  const addLiability = async (liability) => {
    const res = await apiFetch(`${API_URL}/liabilities`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(liability)
    });
    if (res.status === 401) {
      dropLiabilitiesAndEndSession();
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to add liability');
    applyLiabilityCreated(data);
    return data;
  };

  // Records a repayment toward one liability. The server returns the updated liability, which replaces the matching
  // entry (no refetch). Throws on failure so the form can show the server's message; a 401 ends the session.
  const addLiabilityRepayment = async (liabilityId, amount) => {
    const res = await apiFetch(`${API_URL}/liabilities/${encodeURIComponent(liabilityId)}/repayments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    if (res.status === 401) {
      dropLiabilitiesAndEndSession();
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to add repayment');
    applyLiabilityUpdated(data.liability);
    return data;
  };

  const deleteLiability = async (id) => {
    const res = await apiFetch(`${API_URL}/liabilities/${id}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    if (res.status === 401) {
      dropLiabilitiesAndEndSession();
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete liability');
    }
    setLiabilities(prev => prev.filter(l => l.id !== id));
  };

  // Saves (creates or replaces) the emergency fund. Throws on failure so the form can show the server's
  // validation message inline; a 401 ends the session.
  const saveEmergencyFund = async (values) => {
    const res = await apiFetch(`${API_URL}/emergency-fund`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values)
    });
    if (res.status === 401) {
      setEmergencyFund(null);
      invalidateSession();
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save emergency fund');
    setEmergencyFund(data);
    return data;
  };

  // Handles pasting text or uploading files
  const parseStatement = async (input) => {
    setLoading(true);
    setError(null);
    try {
      let res;
      if (input instanceof File) {
        const formData = new FormData();
        formData.append('statementFile', input);
        res = await apiFetch(`${API_URL}/transactions/parse-statement?duplicates=report`, {
          method: 'POST',
          credentials: 'include',
          body: formData
        });
      } else {
        res = await apiFetch(`${API_URL}/transactions/parse-statement?duplicates=report`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: input })
        });
      }

      if (res.status === 401) {
        invalidateSession();
        throw new Error('Session expired');
      }
      if (res.status === 409) {
        // Duplicate review, not an error: the server held the import back and saved NOTHING. The page shows the review.
        const held = await res.json().catch(() => null);
        const preview = held?.code === 'DUPLICATES_FOUND' ? normalizePreview(held) : null;
        if (preview) return { review: true, preview };
        throw new Error(held?.error || 'Failed to parse statement');
      }
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to parse statement');
      }

      const result = await res.json();
      await fetchTransactions(); // Refresh all transactions
      return result;
    } catch (err) {
      console.error(err);
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Duplicate review, step 2: send the user's decision about a held-back import. `request` is built from the preview the server
  // issued ({ rows, policy, reviewDigest, skipIndexes }); nothing is parsed again. Resolves { stale: false, result } after the import
  // (and a refresh of the transaction list) or { stale: true, preview } when the server refused a review that went out of date.
  const confirmImport = async (request) => {
    try {
      const outcome = await requestImportConfirm({ apiUrl: API_URL, body: request, fetchImpl: apiFetch });
      if (outcome.stale) return outcome;
      await fetchTransactions();
      return outcome;
    } catch (err) {
      if (err?.status === 401) {
        invalidateSession();
        throw new Error('Session expired', { cause: err });
      }
      throw err;
    }
  };

  // Image statement upload, step 1: read the text out of a JPG/PNG. Resolves { text, confidence, warnings } and changes nothing
  // else: no transaction is saved, parseStatement is not called, and the shared loading/error state is left alone (the page
  // shows its own progress). The user reviews the text in the paste editor and imports it themselves.
  const extractTextFromImage = async (file) => {
    try {
      return await requestImageText({ apiUrl: API_URL, file, fetchImpl: apiFetch });
    } catch (err) {
      if (err?.status === 401) {
        invalidateSession();
        throw new Error('Session expired', { cause: err });
      }
      throw err;
    }
  };

  // Sends the bounded chat history (src/utils/chatHistory.js) with the user's LOCAL date (only used to resolve "today" /
  // "yesterday") and resolves to { reply, action }. `action` is the server's proposal / clarification / cancellation
  // for a confirmed financial action (Issue #73), or null. Failures reject with a message that can be shown to the user
  // as-is; the caller keeps such messages out of later history.
  const sendAssistantMessage = async (messages, { localDate = localDateString() } = {}) => {
    let res;
    try {
      res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...accountHeaders(user) },
        body: JSON.stringify({ messages, localDate })
      });
    } catch {
      throw new Error("I couldn't reach the FinSphere server. Please check your connection and try again.");
    }
    await refuseIfAccountChanged(res, retryIdentityCheck);
    if (res.status === 401) {
      invalidateSession();
      throw new Error('Your session has expired. Please sign in again.');
    }
    if (res.status === 429) throw new Error("You're sending messages quickly. Please wait a minute and try again.");
    if (res.status === 400) throw new Error("I couldn't process that message. Please rephrase it and try again.");
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!data || typeof data.reply !== 'string') throw new Error('Something went wrong on our side. Please try again.');
    return { reply: data.reply, action: data.action ?? null, visualization: data.visualization ?? null };
  };

  const sendMessageToBot = async (messages) => (await sendAssistantMessage(messages)).reply;

  // Confirms a server-held proposal. Only the id is sent: the amount, title, goal and owner are the ones the server
  // stored when it showed the preview. On success the stored row is applied to shared state exactly like a manual
  // write (a replay returns the same stored result and is applied only once). Rejects with the server's safe message;
  // `err.actionStatus` is the proposal's status ('expired', 'cancelled', 'failed', ...).
  const confirmAssistantAction = async (proposalId) => {
    const res = await fetch(`${API_URL}/assistant/actions/${encodeURIComponent(proposalId)}/confirm`, {
      method: 'POST',
      credentials: 'include',
      headers: accountHeaders(user)
    });
    await refuseIfAccountChanged(res, retryIdentityCheck);
    if (res.status === 401) {
      invalidateSession();
      throw new Error('Your session has expired. Please sign in again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'I could not complete that. Nothing was saved.');
      err.actionStatus = data.status ?? null;
      throw err;
    }
    if (data.transaction) applyTransactionCreated(data.transaction);
    if (data.goal) applyGoalUpdated(data.goal);
    if (data.liability) (data.kind === 'create_liability' ? applyLiabilityCreated : applyLiabilityUpdated)(data.liability);
    if (data.budget) await applyBudgetSaved(data.budget);
    return data;
  };

  const cancelAssistantAction = async (proposalId) => {
    const res = await fetch(`${API_URL}/assistant/actions/${encodeURIComponent(proposalId)}/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: accountHeaders(user)
    });
    await refuseIfAccountChanged(res, retryIdentityCheck);
    if (res.status === 401) {
      invalidateSession();
      throw new Error('Your session has expired. Please sign in again.');
    }
    return res.json().catch(() => ({}));
  };

  // Derive Stats classification-aware (see src/utils/finance.js): totalIncome and totalExpenses are all-time
  // analytical income and net spending (refunds and transfers handled; unlabelled rows count by direction);
  // balance is the raw signed total of everything recorded; currentMonth/previousMonth are local calendar-month
  // figures with the same semantics.
  const { totalIncome, totalExpenses, balance, currentMonth, previousMonth } =
    summarizeTransactions(transactions);

  return (
    <FinanceContext.Provider value={{
      transactions,
      loading,
      error,
      totalIncome,
      totalExpenses,
      balance,
      currentMonth,
      previousMonth,
      goals,
      goalsLoading,
      goalsError,
      fetchGoals,
      addGoal,
      deleteGoal,
      addGoalContribution,
      liabilities,
      liabilitiesLoading,
      liabilitiesError,
      fetchLiabilities,
      addLiability,
      deleteLiability,
      addLiabilityRepayment,
      emergencyFund,
      emergencyFundLoading,
      emergencyFundError,
      fetchEmergencyFund,
      saveEmergencyFund,
      budgets,
      budgetsMonth,
      budgetsLoading,
      budgetsError,
      fetchBudgets,
      saveBudget,
      deleteBudget,
      fetchTransactions,
      addTransaction,
      deleteTransaction,
      updateTransactionCategory,
      updateTransaction,
      parseStatement,
      confirmImport,
      extractTextFromImage,
      sendMessageToBot,
      sendAssistantMessage,
      confirmAssistantAction,
      cancelAssistantAction,
      currentView,
      setCurrentView
    }}>
      {children}
    </FinanceContext.Provider>
  );
};
