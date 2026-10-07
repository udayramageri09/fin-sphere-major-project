/* eslint-disable react-refresh/only-export-components, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
import { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { summarizeTransactions } from '../utils/finance';

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
  const { invalidateSession } = useAuth();

  const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

  const fetchTransactions = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/transactions`, { credentials: 'include' });
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
      const res = await fetch(`${API_URL}/goals`, { credentials: 'include' });
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

  useEffect(() => {
    fetchTransactions();
    fetchGoals();
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  }, []);

  const addTransaction = async (txn) => {
    setError(null);
    try {
      const res = await fetch(`${API_URL}/transactions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(txn)
      });
      if (res.status === 401) {
        invalidateSession();
        throw new Error('Session expired');
      }
      if (!res.ok) throw new Error('Failed to add transaction');
      const newTxn = await res.json();
      setTransactions(prev => [newTxn, ...prev]);
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
      const res = await fetch(`${API_URL}/transactions/${id}`, {
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

  // Goal create/delete throw on failure so the caller can show the message inline
  // (the server's validation text is passed through); a 401 ends the session.
  const addGoal = async (goal) => {
    const res = await fetch(`${API_URL}/goals`, {
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
    const res = await fetch(`${API_URL}/goals/${id}`, {
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

  // Handles pasting text or uploading files
  const parseStatement = async (input) => {
    setLoading(true);
    setError(null);
    try {
      let res;
      if (input instanceof File) {
        const formData = new FormData();
        formData.append('statementFile', input);
        res = await fetch(`${API_URL}/transactions/parse-statement`, {
          method: 'POST',
          credentials: 'include',
          body: formData
        });
      } else {
        res = await fetch(`${API_URL}/transactions/parse-statement`, {
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

  const sendMessageToBot = async (messages) => {
    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
      });
      if (res.status === 401) {
        invalidateSession();
        throw new Error('Session expired');
      }
      if (!res.ok) throw new Error('Failed to fetch AI chat response');
      const data = await res.json();
      return data.reply;
    } catch (err) {
      console.error(err);
      return 'Sorry, I am having trouble connecting to my cognitive backend right now. Please try again! 🤖';
    }
  };

  // Derive Stats from the signed amount (> 0 income, < 0 expense). totalIncome and
  // totalExpenses are all-time magnitudes; balance is all-time income minus
  // expenses; currentMonth/previousMonth are local calendar-month figures.
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
      fetchTransactions,
      addTransaction,
      deleteTransaction,
      parseStatement,
      sendMessageToBot,
      currentView,
      setCurrentView
    }}>
      {children}
    </FinanceContext.Provider>
  );
};
