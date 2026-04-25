import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report
import matplotlib.pyplot as plt
import seaborn as sns

# ==========================================
# 1. Dataset Simulation
# ==========================================
def simulate_loan_data(n_samples=1000):
    np.random.seed(42)
    
    # Features
    income = np.random.normal(50000, 15000, n_samples).clip(15000, 150000)
    debt = np.random.normal(10000, 5000, n_samples).clip(0, 50000)
    credit_score = np.random.normal(650, 100, n_samples).clip(300, 850)
    loan_amount = np.random.normal(20000, 10000, n_samples).clip(1000, 100000)
    
    # Target Logic: Eligibility
    # Approved if (higher credit score) and (lower debt-to-income ratio)
    dti = debt / income
    l_to_i = loan_amount / income
    
    # Scoring for approval
    score = (0.5 * (credit_score / 850)) + (0.3 * (1 - dti)) - (0.2 * l_to_i)
    noise = np.random.normal(0, 0.05, n_samples)
    
    eligible = (score + noise > 0.45).astype(int)
    
    df = pd.DataFrame({
        'income': income,
        'debt': debt,
        'credit_score': credit_score,
        'loan_amount': loan_amount,
        'eligible': eligible
    })
    
    return df

# ==========================================
# 2. Data Preprocessing & Training
# ==========================================
def train_and_compare_models(df):
    X = df.drop('eligible', axis=1)
    y = df['eligible']
    
    # Split
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    # Scaling (Crucial for Logistic Regression)
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)
    
    models = {
        "Logistic Regression": LogisticRegression(),
        "Decision Tree": DecisionTreeClassifier(max_depth=5),
        "Random Forest": RandomForestClassifier(n_estimators=100, max_depth=5)
    }
    
    results = {}
    best_model = None
    best_acc = 0
    
    print("--- Model Performance Comparison ---")
    for name, model in models.items():
        # Use scaled data for LR, raw for Trees (though scaled works too)
        train_data = X_train_scaled if name == "Logistic Regression" else X_train
        test_data = X_test_scaled if name == "Logistic Regression" else X_test
        
        model.fit(train_data, y_train)
        y_pred = model.predict(test_data)
        acc = accuracy_score(y_test, y_pred)
        results[name] = acc
        print(f"{name}: Accuracy = {acc:.4f}")
        
        if acc > best_acc:
            best_acc = acc
            best_model = (name, model, scaler if name == "Logistic Regression" else None)

    print(f"\nBest Model: {best_model[0]}")
    return best_model, X.columns

# ==========================================
# 3. Prediction & Explanation
# ==========================================
def predict_loan_eligibility(model_bundle, features, input_data):
    name, model, scaler = model_bundle
    
    # Format input
    input_df = pd.DataFrame([input_data])
    
    # Process input
    if scaler:
        processed_input = scaler.transform(input_df)
    else:
        processed_input = input_df
        
    prediction = model.predict(processed_input)[0]
    prob = model.predict_proba(processed_input)[0][1]
    
    status = "APPROVED" if prediction == 1 else "REJECTED"
    
    # Simple Logic-based Explanation
    explanation = []
    dti = input_data['debt'] / input_data['income']
    if input_data['credit_score'] < 600:
        explanation.append("Credit score is below ideal threshold (600).")
    if dti > 0.4:
        explanation.append("Debt-to-income ratio is high (>40%).")
    if input_data['loan_amount'] > (input_data['income'] * 0.5):
        explanation.append("Requested loan amount is high relative to annual income.")
    
    if prediction == 1:
        if not explanation:
            explanation_str = "All financial metrics are within healthy ranges."
        else:
            explanation_str = f"Approved despite: {', '.join(explanation)}"
    else:
        explanation_str = f"Rejected due to: {'; '.join(explanation) if explanation else 'Model-weighted risk assessment.'}"
        
    return status, prob, explanation_str

# ==========================================
# 4. Main Execution
# ==========================================
if __name__ == "__main__":
    df = simulate_loan_data()
    best_bundle, feature_names = train_and_compare_models(df)
    
    # Feature Importance (for Random Forest)
    if "Random Forest" in best_bundle[0] or "Decision Tree" in best_bundle[0]:
        importances = best_bundle[1].feature_importances_
        print("\n--- Feature Importances ---")
        for name, imp in zip(feature_names, importances):
            print(f"{name}: {imp:.4f}")
            
    # Sample Prediction
    sample_user = {
        'income': 65000,
        'debt': 5000,
        'credit_score': 720,
        'loan_amount': 15000
    }
    
    print("\n--- Sample Prediction ---")
    status, prob, reason = predict_loan_eligibility(best_bundle, feature_names, sample_user)
    print(f"User Input: {sample_user}")
    print(f"Decision: {status} (Approval Probability: {prob:.2%})")
    print(f"Explanation: {reason}")
    
    # Another sample (at risk)
    risky_user = {
        'income': 30000,
        'debt': 15000,
        'credit_score': 550,
        'loan_amount': 40000
    }
    print("\n--- Sample Prediction (Risky) ---")
    status, prob, reason = predict_loan_eligibility(best_bundle, feature_names, risky_user)
    print(f"User Input: {risky_user}")
    print(f"Decision: {status} (Approval Probability: {prob:.2%})")
    print(f"Explanation: {reason}")
