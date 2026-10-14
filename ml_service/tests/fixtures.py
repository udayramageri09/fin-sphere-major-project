"""Fixed transaction fixtures for the health scorer / plan generator tests (Issue #80).

Plain data only: the same inputs are used to prove that scores and rule outcomes did not change.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


def tx(i, title, amount, date, type_, category='General', classification='unknown'):
    return {'id': i, 'title': title, 'amount': amount, 'date': date, 'type': type_, 'category': category, 'classification': classification}


def typical():
    """Four months: salary, rent/food/transport spending, one refund, one transfer, one investment credit."""
    rows = []
    n = 0
    for month in ('2026-05', '2026-06', '2026-07', '2026-08'):
        n += 1; rows.append(tx(n, 'Salary', 50000, f'{month}-01', 'income', 'Salary', 'income'))
        n += 1; rows.append(tx(n, 'Rent', -15000, f'{month}-03', 'expense', 'Rent', 'expense'))
        n += 1; rows.append(tx(n, 'Groceries', -6000, f'{month}-10', 'expense', 'Food', 'expense'))
        n += 1; rows.append(tx(n, 'Dinner', -2500, f'{month}-15', 'expense', 'Food', 'expense'))
        n += 1; rows.append(tx(n, 'Metro', -1500, f'{month}-18', 'expense', 'Transport', 'expense'))
    rows.append(tx(100, 'Shoes refund', 2000, '2026-07-20', 'income', 'Food', 'refund'))
    rows.append(tx(101, 'To savings account', -10000, '2026-08-05', 'expense', 'Savings', 'transfer'))
    rows.append(tx(102, 'Mutual fund dividend', 1500, '2026-08-25', 'income', 'Investment', 'income'))
    return rows


def healthy():
    rows = []
    n = 0
    for month in ('2026-06', '2026-07', '2026-08'):
        n += 1; rows.append(tx(n, 'Salary', 100000, f'{month}-01', 'income', 'Salary', 'income'))
        n += 1; rows.append(tx(n, 'Living', -30000, f'{month}-05', 'expense', 'Living', 'expense'))
        n += 1; rows.append(tx(n, 'SIP', 20000, f'{month}-07', 'income', 'Investment', 'income'))
    return rows


def stressed():
    rows = []
    n = 0
    for month in ('2026-06', '2026-07', '2026-08'):
        n += 1; rows.append(tx(n, 'Salary', 30000, f'{month}-01', 'income', 'Salary', 'income'))
        n += 1; rows.append(tx(n, 'Rent', -20000, f'{month}-03', 'expense', 'Rent', 'expense'))
        n += 1; rows.append(tx(n, 'Food', -15000, f'{month}-12', 'expense', 'Food', 'expense'))
        n += 1; rows.append(tx(n, 'Fun', -10000, f'{month}-20', 'expense', 'Fun', 'expense'))
    return rows


def no_income():
    return [
        tx(1, 'Rent', -12000, '2026-07-03', 'expense', 'Rent', 'expense'),
        tx(2, 'Food', -4000, '2026-07-10', 'expense', 'Food', 'expense'),
        tx(3, 'Food', -3000, '2026-08-10', 'expense', 'Food', 'expense'),
    ]
