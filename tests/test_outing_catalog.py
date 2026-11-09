import copy
import json
import sys
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import outing_catalog as catalog
import tonight_plans
import collect_weekend

class LivingCatalogTests(unittest.TestCase):
    def setUp(self):
        self.now=catalog.news.parse_date('2026-11-06T08:00:00Z')
        self.item={'name':'杭州例子陶艺工坊','area':'杭州市余杭区五常街道','description':'店内开放陶艺手作体验，可以亲手制作杯子和小碗。',
                   'group':'rainy','url':'https://hznews.hangzhou.com.cn/example','conditions':['营业与课程请向店员确认。']}
        self.body='\n'.join([self.item['name'],self.item['area'],self.item['description'],*self.item['conditions']])
        self.trusted=lambda url:url.startswith('https://hznews.hangzhou.com.cn/')
    def validate(self,item=None,body=None,base=()):
        return catalog.validate(item or self.item,body or self.body,{self.item['url']},base,self.now,self.trusted)
    def test_only_proved_places_are_added_and_existing_places_are_not_renamed_as_new(self):
        place=self.validate()
        self.assertEqual(place['group'],'rainy')
        self.assertEqual(place['addedAt'],catalog.news.iso(self.now))
        self.assertIsNone(self.validate({**self.item,'area':'杭州市西湖区虚构地址'}))
        self.assertIsNone(self.validate({**self.item,'url':'https://untrusted.example/'}))
        self.assertIsNone(self.validate(base=[{'name':self.item['name']+' · 陶艺'}]))
        unwanted={**self.item,'name':'杭州亲子陶艺工坊'}
        self.assertIsNone(self.validate(unwanted,self.body.replace(self.item['name'],unwanted['name'])))
    def test_failed_recheck_keeps_old_verification_time_and_does_not_call_ai_twice_a_day(self):
        place=self.validate();place['verifiedAt']=catalog.news.iso(self.now-timedelta(days=8))
        previous={'day':'2026-11-06','revision':catalog.REVISION,'places':[place]}
        client=Mock();client.state={}
        result=catalog.update(client,previous,[],self.now,get=Mock(side_effect=TimeoutError()),trusted=self.trusted,citations=lambda _:set())
        self.assertEqual(result['places'][0]['sourceStatus'],'unavailable')
        self.assertEqual(result['places'][0]['verifiedAt'],place['verifiedAt'])
        self.assertNotIn('checkedAt',previous['places'][0])
        client.ask.assert_not_called()
    def test_distinct_events_keep_sources_while_noise_is_removed(self):
        def article(id,title):
            return {'id':id,'title':title,'url':'https://example.com/'+id,'publishedAt':'2026-11-06T05:00:00Z','outing':{'type':'culture'}}
        result=collect_weekend.select_articles([article('a','杭州文博会开幕'),article('b','第二十届杭州文博会看点'),
            article('c','杭州陶艺工作坊预约'),article('d','杭州博物馆特展'),article('e','3亿起拍！杭州商场被摆上货架')],self.now)
        self.assertEqual(len(result),2)
        self.assertEqual(result[0]['reports'][0]['id'],'b')
        self.assertNotEqual(result[0]['title'],result[1]['title'])
        again=collect_weekend.select_articles(result+[article('b','第二十届杭州文博会看点')],self.now)
        self.assertEqual([r['id'] for r in again[0]['reports']],['b'])
        self.assertEqual(len(result[0]['reports']),1)
    def test_evening_weather_is_hourly_and_failure_preserves_last_good_time(self):
        hourly={'time':['2026-11-06T12:00','2026-11-06T19:00','2026-11-06T20:00','2026-11-06T21:00','2026-11-06T22:00'],
                'precipitation_probability':[99,5,10,10,5],'precipitation':[10,0,0,0,0],
                'wind_speed_10m':[15]*5,'weather_code':[63,1,1,1,1]}
        response={'timezone':'Asia/Shanghai','hourly_units':{'wind_speed_10m':'km/h','precipitation':'mm'},'hourly':hourly}
        result=tonight_plans.update_weather({},self.now,lambda _:json.dumps(response))
        self.assertEqual(len(result['hours']),4)
        self.assertEqual(max(r['rainProbability'] for r in result['hours']),10)
        self.assertEqual(result['area'],'杭州五常附近')
        fresh=Mock(side_effect=AssertionError('Fresh Wuchang forecast should be reused'))
        self.assertEqual(tonight_plans.update_weather(result,self.now+timedelta(minutes=10),fresh),result)
        fresh.assert_not_called()
        legacy={**result};legacy.pop('area')
        fetch=Mock(return_value=json.dumps(response))
        self.assertEqual(tonight_plans.update_weather(legacy,self.now+timedelta(minutes=10),fetch)['area'],'杭州五常附近')
        self.assertIn('longitude=120.02',fetch.call_args.args[0])
        failed=tonight_plans.update_weather(result,self.now+timedelta(hours=2),Mock(side_effect=TimeoutError()))
        self.assertEqual(failed['updatedAt'],result['updatedAt'])
        self.assertEqual(failed['status'],'unavailable')

if __name__=='__main__':unittest.main()
