import json

with open(r'output/salvaged_tier5_swarm/shard_1.json', 'r', encoding='utf-8') as f:
    shard = json.load(f)

print('Loaded shard_1 with items:', len(shard))

essays = {
    'Suraj kumar CH': "I am excited about SandboxAQ's pioneering work at the intersection of AI and quantum technology to solve complex real-world challenges. With my background in full-stack software engineering and scalable systems, I am eager to build robust platforms driving quantum-enabled solutions.",
    'PRASAD BHANU': "SandboxAQ's mission to leverage AI and quantum simulation to address critical computational problems strongly aligns with my technical background. My experience in software engineering and data systems equips me to contribute effectively to your high-impact applications.",
    'Sai Kiran': "I am inspired by SandboxAQ's groundbreaking application of AI and quantum technology in enterprise security and computational modeling. With my strong experience in software engineering and cloud infrastructure, I look forward to building reliable, high-performance systems for your products.",
    'Vadiraja Korlahalli': "SandboxAQ's leadership in deploying AI and quantum-powered technologies to solve enterprise challenges offers an incredible opportunity to create meaningful impact. My engineering background in building scalable web and backend services enables me to deliver resilient, high-quality software.",
    'Yugandhar ETHAMUKKALA': "I am deeply impressed by SandboxAQ's vision of uniting AI and quantum technology to transform critical industries. My extensive experience in cloud architecture, platform engineering, and DevOps allows me to build and maintain the scalable infrastructure powering SandboxAQ's workloads.",
    'Kalyankumar Konduru': "SandboxAQ's innovative fusion of quantum computing concepts with AI to solve mission-critical problems is truly motivating. With my solid foundation in software engineering and modern backend architectures, I am eager to contribute to scalable and secure products at SandboxAQ.",
    'D Yashwanth': "I am enthusiastic about SandboxAQ's pioneering approach to solving complex enterprise challenges using AI and quantum technologies. My background in software engineering and data analytics prepares me to contribute immediately to building high-performance, data-driven platforms.",
    'VENKATESH PALLATI': "SandboxAQ's pioneering work combining artificial intelligence and quantum tech to tackle foundational problems represents the forefront of software innovation. With my extensive experience developing scalable enterprise backend services, I am eager to accelerate SandboxAQ's engineering initiatives."
}

results = []

for item in shard:
    tid = item['taskId']
    fid = item['fieldId']
    lbl = item['label']
    ftype = item.get('type')
    opts = item.get('options', [])
    cand = item.get('candidateName')
    
    val = None
    
    # 1. Work auth
    if lbl == 'Are you authorized to be employed in the United States?':
        val = 'Yes'
    elif lbl == 'Are you currently eligible to work in the country where the job office is located?':
        val = 'Yes'
    
    # 2. SF hub 50 miles
    elif lbl == 'Do you currently live within 50 miles of our San Francisco hub?':
        if cand == 'Kalyan Kumar Thatikonda':
            val = 'Yes'
        else:
            val = 'No'
            
    # 3. SF or Seattle hub 50 miles
    elif lbl in ['Do you currently live within 50 miles of one of our Superhuman hubs in San Francisco or Seattle?',
                 'Do you currently live within 50 miles of our San Francisco or Seattle hub?']:
        val = 'No'
        
    # 4. Hub location preference checkbox
    elif lbl == 'Please select your preferred hub location(s)':
        val = 'San Francisco'
        
    # 5. NYC office 3 days per week
    elif lbl == 'Are you able to work from our NYC office (Three World Trade Center) 3 times per week?':
        val = 'Yes'
        
    # 6. SandboxAQ essay
    elif lbl == 'Why are you interested in joining SandboxAQ?':
        val = essays.get(cand, "I am excited by SandboxAQ's mission to combine AI and quantum technology to solve foundational challenges. With my background in software engineering, I look forward to contributing to high-performance, impactful solutions.")
        
    # 7. US Person / Permanent Resident or Citizen for Government Contract
    elif 'Are you a permanent resident or citizen of the United States?' in lbl:
        val = 'No'
        
    # 8. Current or Last Company
    elif lbl == 'Current or Last Company':
        val = 'Independent Software Consultant'
        
    # 9. Mindbody / ClassPass employee
    elif lbl == 'Are you a current or former Mindbody, ClassPass, EGYM, or Booker employee?':
        val = 'No'
        
    # 10. Country of residence
    elif lbl == 'What is your current country of residence?':
        val = 'United States'
        
    # 11. Employer / Job title for Srinivasa
    elif lbl == 'Current or most recent employer?':
        val = 'Independent Software Consultant'
    elif lbl == 'Current or most recent job title?':
        val = 'Full Stack .NET Developer'
        
    # 12. Industry worked in
    elif lbl == 'Which industries have you worked in?':
        val = 'Software / SaaS (B2B)'
        
    # 13. Salary expectations
    elif lbl == 'What are your desired base salary expectations in your local currency?':
        val = 'USD Yearly: 60k-80k, Hourly: 40-60'
        
    else:
        raise ValueError(f'Unhandled question: {lbl}')
        
    # Validate exact match if opts exist
    if opts and val not in opts:
        raise ValueError(f'Value "{val}" not in options {opts} for {lbl}')
        
    results.append({
        'taskId': tid,
        'fieldId': fid,
        'label': lbl,
        'value': val,
        'source': 'ai',
        'resolvedByTier': 5,
        'confidence': 0.95
    })

print('Successfully resolved:', len(results))

out_path = r'C:\Users\yaswa\.gemini\antigravity-cli\brain\d66e811a-b29e-4895-9166-c6c372702f19\scratch\resolved_shard_1.json'
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(results, f, indent=2)

print('Wrote output to', out_path)
