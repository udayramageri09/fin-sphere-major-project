export const DEMO_EMAIL = 'faculty.demo@finsphere.test';
export const DEMO_NAME = 'Faculty Demo Â· Sample data';
export function facultyDemoData(now = new Date()) {
  const transactions = [];
  // Include the current month so the dashboard has demo figures, with no future transactions.
  for (let back = 11; back >= 0; back--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, Math.min(5, now.getUTCDate())));
    const month = date.toISOString().slice(0,7);
    const index = 11 - back;
    for (const [title, amount, category, classification] of [
      ['Salary',78000+index*1000,'Salary','income'],
      ['Rent',-18000,'Housing','expense'],
      ['Groceries',-(5200+index*100),'Groceries','expense'],
      ['Dining',-(2200+index*180),'Food','expense'],
      ['Transport',-2400,'Transport','expense'],
      ['Subscriptions',-799,'Entertainment','expense'],
      ['Index fund investment',-6000,'Investments','transfer'],
      ['Education loan payment',-6500,'Loan','expense'],
    ]) transactions.push({title:`[Demo] ${title} ${month}`,amount,category,classification,type:amount>0?'income':'expense',date:date.toISOString().slice(0,10)});
  }
  transactions.push({title:'[Demo] Laptop purchase',amount:-58000,category:'Shopping',classification:'expense',type:'expense',date:transactions.at(-1).date});
  const targetDate = new Date(Date.UTC(now.getUTCFullYear()+1,now.getUTCMonth(),1)).toISOString().slice(0,10);
  return {
    transactions,
    goals:[{title:'[Demo] Professional certification',targetAmount:80000,currentAmount:24000,targetDate},{title:'[Demo] Travel fund',targetAmount:120000,currentAmount:42000,targetDate}],
    liabilities:[{name:'[Demo] Education loan',type:'education_loan',outstandingAmount:240000,interestRate:9.5,monthlyPayment:6500}],
    emergencyFund:{currentAmount:65000,targetAmount:240000},
    holdings:[{name:'[Demo] Index fund',assetClass:'Mutual funds',investedPaise:24000000,currentPaise:26800000,valuedOn:now.toISOString().slice(0,10)},{name:'[Demo] Fixed deposit',assetClass:'Deposits',investedPaise:10000000,currentPaise:10600000,valuedOn:now.toISOString().slice(0,10)}],
  };
}
