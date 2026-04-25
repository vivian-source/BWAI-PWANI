import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
import json
import matplotlib.pyplot as plt
import seaborn as sns

# =================================================================
# CHAMA GUARD: Alternative Data Synthetic Generator & Scoring Model
# =================================================================

def generate_synthetic_data(n_samples=500):
    """
    Simulates unconventional data points for Kenya's informal economy.
    """
    np.random.seed(42)
    
    # 1. M-Pesa Patterns
    # Tx frequency (daily), Fuliza usage (0 to 1, where 1 is high dependency)
    tx_frequency = np.random.normal(15, 5, n_samples).clip(1, 40)
    fuliza_dependency = np.random.uniform(0, 1, n_samples)
    merchant_payment_ratio = np.random.uniform(0.1, 0.8, n_samples)
    
    # 2. Social Collateral
    # Previous Chama contribution history (0-100 score)
    # Peer vouching (Number of distinct community leaders vouching)
    chama_history_score = np.random.normal(75, 15, n_samples).clip(0, 100)
    peer_vouches = np.random.poisson(3, n_samples)
    
    # 3. Business Records (Extracted from SMS simulated receipts)
    # Stock-to-Sales Velocity
    stock_velocity = np.random.uniform(0.5, 2.0, n_samples)
    
    # Define Ground Truth (Creditworthiness)
    # A mix of social and financial consistency
    noise = np.random.normal(0, 5, n_samples)
    target_score = (
        (0.3 * (tx_frequency * 2.5)) + 
        (0.4 * chama_history_score) + 
        (0.2 * (peer_vouches * 10)) - 
        (0.5 * (fuliza_dependency * 100))
    ) + noise
    
    # Binary target for Classifier (1 = Success/Creditworthy, 0 = High Risk)
    y = (target_score > 60).astype(int)
    
    df = pd.DataFrame({
        'tx_freq': tx_frequency,
        'fuliza_dep': fuliza_dependency,
        'merchant_ratio': merchant_payment_ratio,
        'chama_score': chama_history_score,
        'peer_vouches': peer_vouches,
        'stock_velocity': stock_velocity,
        'label': y
    })
    
    return df

def visualize_feature_importance(importances, save_path="feature_importance.png"):
    """
    Creates a bar chart for feature importances and saves it as an image.
    """
    # Sort features by importance
    sorted_features = sorted(importances.items(), key=lambda item: item[1], reverse=True)
    features = [f[0] for f in sorted_features]
    values = [f[1] for f in sorted_features]

    plt.figure(figsize=(10, 6))
    sns.set_theme(style="whitegrid")
    
    # Create the horizontal bar plot
    palette = sns.color_palette("viridis", len(features))
    sns.barplot(x=values, y=features, hue=features, palette=palette, legend=False)
    
    plt.title('ChamaGuard AI: Alternative Data Feature Importance', fontsize=16, fontweight='bold')
    plt.xlabel('Importance Score', fontsize=12)
    plt.ylabel('Alternative Metric', fontsize=12)
    
    # Clean up layout
    plt.tight_layout()
    
    # Save the plot
    plt.savefig(save_path)
    print(f"\nVisualization saved to: {save_path}")
    plt.close()

def train_scoring_engine():
    print("Generating synthetic 'Hustle Economy' dataset...")
    data = generate_synthetic_data()
    
    X = data.drop('label', axis=1)
    y = data['label']
    
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)
    
    # Random Forest: Lightweight and capture non-linear relationships in social data
    model = RandomForestClassifier(n_estimators=100, max_depth=5)
    model.fit(X_train, y_train)
    
    print(f"Model Training Complete. Accuracy: {model.score(X_test, y_test):.2f}")
    
    # Feature Importance - How does the AI weigh these metrics?
    importances = dict(zip(X.columns, model.feature_importances_))
    print("\nAlternative Metric Weights (Feature Importance):")
    for k, v in sorted(importances.items(), key=lambda item: item[1], reverse=True):
        print(f" - {k}: {v:.4f}")
        
    # Visualize and save the importances
    visualize_feature_importance(importances)
        
    return model

def chama_sustainability_logic(members_data):
    """
    Calculates the Probability of Chama Success.
    Formula: 1 - (Variance in Member Commitment * 1.5)
    """
    commitment_variance = np.var([m['commitment_score'] for m in members_data])
    avg_score = np.mean([m['credit_score'] for m in members_data])
    
    # Penalty for asymmetric information (one very low score in a small group)
    min_score = min([m['credit_score'] for m in members_data])
    
    sustainability = (avg_score * 0.7) + (min_score * 0.3) - (commitment_variance * 5)
    return max(0, min(100, sustainability))

if __name__ == "__main__":
    trained_model = train_scoring_engine()
    print("\nPrivacy Framework: On-Device Implementation Recommendation")
    print("---------------------------------------------------------")
    print("1. Local SMS Parsing: Use Regex on-device to extract amounts/merchants.")
    print("2. Vectorization: Convert patterns to numerical vectors locally.")
    print("3. Differential Privacy: Add Laplace noise to vectors before aggregation.")
    print("4. Inference: Run the trained .tflite or Scikit-Pickle model on the smartphone.")
