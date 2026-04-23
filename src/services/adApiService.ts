import axios from 'axios';

export interface AdMetric {
  spend: number;
  clicks: number;
  conversions: number;
  ctr?: number;
  cpa?: number;
  cpc?: number;
  roas?: number;
  history?: { date: string, spend: number, conversions: number }[];
}

export const adApiService = {
  getAuthUrl: async (platform: 'meta' | 'google') => {
    const response = await axios.get(`/api/auth/${platform}/url`);
    return response.data.url;
  },

  getMetrics: async (platform: string, accountId: string, encryptedToken: string): Promise<AdMetric> => {
    const response = await axios.get(`/api/metrics/${platform}/${accountId}`, {
      headers: {
        Authorization: `Bearer ${encryptedToken}`
      }
    });
    return response.data;
  }
};
